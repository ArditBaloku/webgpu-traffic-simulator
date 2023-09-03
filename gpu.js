device = null;
async function getDevice() {
  if (device) {
    return device;
  }

  if (!('gpu' in navigator)) {
    console.log('WebGPU is not supported. Enable chrome://flags/#enable-unsafe-webgpu flag.');
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    console.log('Failed to get GPU adapter.');
    return;
  }

  device = await adapter.requestDevice();
  return device;
}

function createGPUBuffer(typedArray, usage) {
  let gpuBuffer = device.createBuffer({
    size: typedArray.byteLength,
    usage: usage,
    mappedAtCreation: true,
  });

  let constructor = typedArray.constructor;
  let view = new constructor(gpuBuffer.getMappedRange());
  view.set(typedArray, 0);
  gpuBuffer.unmap();

  return gpuBuffer;
}

function buildGpuWaysArray() {
  let connectionsOffset = 0;
  let nodesOffset = 0;
  const gpuWays = [];
  const connectionIds = [];

  for (const way of ways) {
    const gpuWay = {
      id: way.id,
      connectionsOffset: connectionsOffset,
      connectionsLength: way.connections.length,
      nodesOffset: nodesOffset,
      nodesLength: way.nodes.length,
      isRoundabout: way.tags.junction && way.tags.junction === 'roundabout' ? true : false,
    };

    gpuWays.push(gpuWay);
    connectionIds.push(...way.connections.map((x) => x.id));
    connectionsOffset += way.connections.length;
    nodesOffset += way.nodes.length;
  }

  const arr = gpuWays.flatMap((way) => [
    way.id,
    way.connectionsOffset,
    way.connectionsLength,
    way.nodesOffset,
    way.nodesLength,
    way.isRoundabout,
  ]);
  return [new Uint32Array(arr), new Uint32Array(connectionIds)];
}

function buildGpuNodesArray() {
  const flatNode = ways.flatMap((x) => x.nodes);
  return new Uint32Array(flatNode.flatMap((x) => [x.id, x.wayId]));
}

function buildGpuCarsArray() {
  return new Uint32Array(gpuCars.flatMap((x) => [x.id, x.wayId, x.nodeId, x.speed]));
}

function buildCpuCarsArray(carsArray) {
  const cars = [];
  for (let i = 0; i < carsArray.length; i += 4) {
    if (carsArray[i] === 0) {
      continue;
    }

    const way = ways.find((x) => x.id === carsArray[i + 1]);
    const node = way.nodes.find((x) => x.id === carsArray[i + 2]);

    cars.push({
      id: carsArray[i],
      wayId: carsArray[i + 1],
      nodeId: carsArray[i + 2],
      speed: carsArray[i + 3],
      lat: node.lat,
      lon: node.lon,
    });
  }
  return cars;
}

waysBuffer = null;
connectionIdsBuffer = null;
nodesBuffer = null;
staticBuffersInitialized = false;
function initStaticBuffers() {
  if (staticBuffersInitialized) {
    return;
  }

  const [gpuWaysArray, connectionIdsArray] = buildGpuWaysArray();
  waysBuffer = createGPUBuffer(
    gpuWaysArray,
    GPUBufferUsage.STORAGE | GPUBufferUsage.READ | GPUBufferUsage.COPY_SRC
  );
  connectionIdsBuffer = createGPUBuffer(
    connectionIdsArray,
    GPUBufferUsage.STORAGE | GPUBufferUsage.READ | GPUBufferUsage.COPY_SRC
  );

  const gpuNodesArray = buildGpuNodesArray();
  nodesBuffer = createGPUBuffer(
    gpuNodesArray,
    GPUBufferUsage.STORAGE | GPUBufferUsage.READ | GPUBufferUsage.COPY_SRC
  );

  staticBuffersInitialized = true;
}

carsBuffer = null;
carsResultsBuffer = null;
function initCarsBuffers() {
  const gpuCarsArray = buildGpuCarsArray();
  carsBuffer = createGPUBuffer(
    gpuCarsArray,
    GPUBufferUsage.STORAGE | GPUBufferUsage.READ | GPUBufferUsage.COPY_SRC
  );
  carsResultsBuffer = createGPUBuffer(
    gpuCarsArray,
    GPUBufferUsage.STORAGE | GPUBufferUsage.READ | GPUBufferUsage.COPY_SRC
  );
}

shaderModule = null;
shaderModuleCreated = false;
function createShaderModule() {
  if (shaderModuleCreated) {
    return;
  }

  shaderModule = device.createShaderModule({
    code: `
    struct Way {
      id: u32,
      connectionsOffset: u32,
      connectionsLength: u32,
      nodesOffset: u32,
      nodesLength: u32,
      isRoundabout: u32,
    }

    struct Node {
      id: u32,
      wayId: u32,
    }

    struct Car {
      id: u32,
      wayId: u32,
      nodeId: u32,
      speed: u32,
    }
    
    @group(0) @binding(0) var<storage, read> ways : array<Way>;
    @group(0) @binding(1) var<storage, read> connectionIds: array<u32>;
    @group(0) @binding(2) var<storage, read> nodes : array<Node>;
    @group(0) @binding(3) var<storage, read> cars : array<Car>;
    @group(0) @binding(4) var<storage, read_write> carResults : array<Car>;
    
    @compute @workgroup_size(8)
    fn main(@builtin(global_invocation_id) global_id : vec3<u32>) {
      var index = global_id.x;
      if (index >= arrayLength(&cars)) {
        return;
      }
      
      var car = cars[index];
      var way : Way;
      var node : Node;
      var nodeIndex : u32;

      for (var i = 0u; i < arrayLength(&ways); i = i + 1u) {
        if (ways[i].id == car.wayId) {
          way = ways[i];
          break;
        }
      }

      for (var i = way.nodesOffset; i < way.nodesOffset + way.nodesLength; i = i + 1u) {
        if (nodes[i].id == car.nodeId) {
          node = nodes[i];
          nodeIndex = i - way.nodesOffset;
          break;
        }
      }

      var currentWay = way;
      var previousWay = way;
      var positionInWay = nodeIndex;
      var previousNode = node;
      var nextNode = previousNode;
      var canSpeedUp = false;
      for (var distanceToCheck = 0u; distanceToCheck < max(car.speed, 1); distanceToCheck = distanceToCheck + 1u) {
        if (positionInWay + 1 > currentWay.nodesLength - 1) {
          if (currentWay.connectionsLength == 0u) {
            carResults[index] = Car(0u, 0u, 0u, 0u);
            return;
          }

          previousWay = currentWay;
          var currentWayId = connectionIds[currentWay.connectionsOffset];

          var foundCurrentWay = false;
          for (var i = 0u; i < arrayLength(&ways); i = i + 1u) {
            if (ways[i].id == currentWayId) {
              currentWay = ways[i];
              foundCurrentWay = true;
              break;
            }
          }

          if (!foundCurrentWay) {
            carResults[index] = Car(0u, 0u, 0u, 0u);
            return;
          }

          var enteringRoundabout = currentWay.isRoundabout == 1u && previousWay.isRoundabout == 0u;
          if (enteringRoundabout) {
            var previousSectionOfRoundabout = Way(0u, 0u, 0u, 0u, 0u, 0u);
            for (var i = 0u; i < arrayLength(&ways); i = i + 1u) {
              var checkingWay = ways[i];
              if (checkingWay.isRoundabout == 1u && checkingWay.connectionsLength != 0u && connectionIds[checkingWay.connectionsOffset] == currentWay.id) {
                previousSectionOfRoundabout = checkingWay;
                break;
              }
            }

            var isCarInRoundabout = false;
            for (var i = 0u; i < arrayLength(&cars); i = i + 1u) {
              if (cars[i].wayId == currentWay.id || cars[i].wayId == previousSectionOfRoundabout.id) {
                isCarInRoundabout = true;
                break;
              }
            }

            if (isCarInRoundabout) {
              carResults[index] = Car(car.id, previousNode.wayId, previousNode.id, 0);
              return;
            }
          }
        }

        nextNode = nodes[currentWay.nodesOffset + positionInWay + 1];
        var isCarOnNextNode = false;
        for (var i = 0u; i < arrayLength(&cars); i = i + 1u) {
          if (cars[i].nodeId == nextNode.id && cars[i].wayId == currentWay.id) {
            isCarOnNextNode = true;
            break;
          }
        }

        if (isCarOnNextNode) {
          carResults[index] = Car(car.id, previousNode.wayId, previousNode.id, distanceToCheck);
          return;
        }

        previousNode = nextNode;
        positionInWay = positionInWay + 1u;

        if (distanceToCheck == max(car.speed, 1) - 1u && car.speed < 2 && car.speed > 0) {
          if (positionInWay + 1 > currentWay.nodesLength - 1) {
            var currentWayId = connectionIds[currentWay.connectionsOffset];
            positionInWay = 0;
            
            if (currentWay.connectionsLength == 0u) {
              break;
            }

            var foundCurrentWay = false;
            for (var i = 0u; i < arrayLength(&ways); i = i + 1u) {
              if (ways[i].id == currentWayId) {
                currentWay = ways[i];
                foundCurrentWay = true;
                break;
              }
            }

            if (!foundCurrentWay) {
              break;
            }

            nextNode = nodes[currentWay.nodesOffset + positionInWay + 1];

            var isCarOnNextNode = false;
            for (var i = 0u; i < arrayLength(&cars); i = i + 1u) {
              if (cars[i].nodeId == nextNode.id) {
                isCarOnNextNode = true;
                break;
              }
            }

            if (!isCarOnNextNode) {
              canSpeedUp = true;
            }
          }
        }
      }

      var speedUp = 0u;
      if (canSpeedUp) {
        speedUp = 1u;
      }

      carResults[index] = Car(car.id, nextNode.wayId, nextNode.id, max(car.speed, 1) + speedUp);
      return;
    }`,
  });

  shaderModuleCreated = true;
}

async function computePassGpu() {
  const device = await getDevice();
  initStaticBuffers();
  initCarsBuffers();
  createShaderModule();

  const computePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: shaderModule,
      entryPoint: 'main',
    },
  });

  const entries = [waysBuffer, connectionIdsBuffer, nodesBuffer, carsBuffer, carsResultsBuffer].map(
    (buffer, index) => ({
      binding: index,
      resource: {
        buffer,
      },
    })
  );
  const bindGroup = device.createBindGroup({
    layout: computePipeline.getBindGroupLayout(0),
    entries,
  });

  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginComputePass();
  passEncoder.setPipeline(computePipeline);
  passEncoder.setBindGroup(0, bindGroup);
  passEncoder.dispatchWorkgroups(8);
  passEncoder.end();

  // Get a GPU buffer for reading in an unmapped state.
  const gpuCarsArray = buildGpuCarsArray();
  const gpuCarsReadBuffer = device.createBuffer({
    size: gpuCarsArray.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  // Encode commands for copying buffer to buffer.
  commandEncoder.copyBufferToBuffer(
    carsResultsBuffer /* source buffer */,
    0 /* source offset */,
    gpuCarsReadBuffer /* destination buffer */,
    0 /* destination offset */,
    gpuCarsArray.byteLength /* size */
  );

  // Submit GPU commands.
  const gpuCommands = commandEncoder.finish();
  device.queue.submit([gpuCommands]);

  // Read buffer.
  await gpuCarsReadBuffer.mapAsync(GPUMapMode.READ);
  const arrayBuffer = gpuCarsReadBuffer.getMappedRange();
  gpuCars = buildCpuCarsArray(new Uint32Array(arrayBuffer));
}
