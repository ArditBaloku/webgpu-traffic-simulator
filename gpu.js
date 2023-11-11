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
  const signalStringToInt = (signal) => {
    switch (signal) {
      case 'green':
        return 0;
      case 'red':
        return 1;
      default:
        return 2;
    }
  };

  return new Uint32Array(
    flatNode.flatMap((x) => [
      x.id,
      x.wayId,
      signalStringToInt(x.signal),
      x.ticks,
      x.redTickLimit,
      x.greenTickLimit,
    ])
  );
}

function buildCpuNodesArray(nodesArray) {
  const nodes = [];
  const signalIntToString = (signal) => {
    switch (signal) {
      case 0:
        return 'green';
      case 1:
        return 'red';
      default:
        return undefined;
    }
  };
  for (let i = 0; i < nodesArray.length; i += 6) {
    nodes.push({
      id: nodesArray[i],
      wayId: nodesArray[i + 1],
      signal: signalIntToString(nodesArray[i + 2]),
      ticks: nodesArray[i + 3],
      redTickLimit: nodesArray[i + 4],
      greenTickLimit: nodesArray[i + 5],
    });
  }
  return nodes;
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
nodesBuffers = null;
function initStaticBuffers() {
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
  nodesBuffers = new Array(2);
  for (let i = 0; i < 2; i++) {
    nodesBuffers[i] = createGPUBuffer(
      gpuNodesArray,
      GPUBufferUsage.STORAGE | GPUBufferUsage.READ | GPUBufferUsage.COPY_SRC
    );
  }
}

carsBuffers = null;
initialCarsSize = 0;
initialCarsByteLength = 0;
function initCarsBuffers() {
  const gpuCarsArray = buildGpuCarsArray();
  initialCarsSize = gpuCarsArray.length;
  initialCarsByteLength = gpuCarsArray.byteLength;
  carsBuffers = new Array(2);
  for (let i = 0; i < 2; i++) {
    carsBuffers[i] = createGPUBuffer(
      gpuCarsArray,
      GPUBufferUsage.STORAGE | GPUBufferUsage.READ | GPUBufferUsage.COPY_SRC
    );
  }
}

shaderModule = null;
function createShaderModule() {
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
      signal: u32, // 0: green, 1: red, 2: not a traffic light
      ticks: u32,
      redTickLimit: u32,
      greenTickLimit: u32,
    }

    struct Car {
      id: u32,
      wayId: u32,
      nodeId: u32,
      speed: u32,
    }

    fn max(num1: u32, num2: u32) -> u32 {
      if (num1 > num2) {
        return num1;
      }

      return num2;
    }
    
    @group(0) @binding(0) var<storage, read> ways : array<Way>;
    @group(0) @binding(1) var<storage, read> connectionIds: array<u32>;
    @group(0) @binding(2) var<storage, read> nodes : array<Node>;
    @group(0) @binding(3) var<storage, read_write> nodeResults : array<Node>;
    @group(0) @binding(4) var<storage, read> cars : array<Car>;
    @group(0) @binding(5) var<storage, read_write> carResults : array<Car>;
    
    @compute @workgroup_size(64)
    fn main(@builtin(global_invocation_id) global_id : vec3<u32>) {
      evolveCar(global_id);
      evolveTrafficLights(global_id);
    }
    
    fn evolveCar(global_id: vec3<u32>) {
      var index = global_id.x;
      if (index >= arrayLength(&cars)) {
        return;
      }
      
      var car = cars[index];

      if (car.id == 0u) {
        carResults[index] = Car(0u, 0u, 0u, 0u);
        return;
      }

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
      for (var distanceToCheck = 0u; distanceToCheck < max(car.speed, 1u); distanceToCheck = distanceToCheck + 1u) {
        if (previousNode.signal == 1u) {
          carResults[index] = Car(car.id, previousNode.wayId, previousNode.id, 0u);
          return;
        }

        if (positionInWay + 1u > currentWay.nodesLength - 1u) {
          if (currentWay.connectionsLength == 0u) {
            carResults[index] = Car(0u, 0u, 0u, 0u);
            return;
          }

          previousWay = currentWay;
          var currentWayId = connectionIds[currentWay.connectionsOffset];
          positionInWay = 0u;

          for (var i = 0u; i < arrayLength(&ways); i = i + 1u) {
            if (ways[i].id == currentWayId) {
              currentWay = ways[i];
              break;
            }
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
              carResults[index] = Car(car.id, previousNode.wayId, previousNode.id, 0u);
              return;
            }
          }
        }

        nextNode = nodes[currentWay.nodesOffset + positionInWay + 1u];
        var isCarOnNextNode = false;
        for (var i = 0u; i < arrayLength(&cars); i = i + 1u) {
          if (cars[i].nodeId == nextNode.id && cars[i].wayId == currentWay.id) {
            isCarOnNextNode = true;
            break;
          }
        }

        if (isCarOnNextNode || nextNode.signal == 1u) {
          carResults[index] = Car(car.id, previousNode.wayId, previousNode.id, distanceToCheck);
          return;
        }

        previousNode = nextNode;
        positionInWay = positionInWay + 1u;

        if (distanceToCheck == max(car.speed, 1u) - 1u && car.speed < 2u && car.speed > 0u) {
          if (positionInWay + 1u > currentWay.nodesLength - 1u) {
            positionInWay = 0u;
            
            if (currentWay.connectionsLength == 0u) {
              break;
            }

            var currentWayId = connectionIds[currentWay.connectionsOffset];

            for (var i = 0u; i < arrayLength(&ways); i = i + 1u) {
              if (ways[i].id == currentWayId) {
                currentWay = ways[i];
                break;
              }
            }
          }

          nextNode = nodes[currentWay.nodesOffset + positionInWay + 1u];

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

      var speedUp = 0u;
      if (canSpeedUp) {
        speedUp = 1u;
      }

      carResults[index] = Car(car.id, nextNode.wayId, nextNode.id, max(car.speed, 1u) + speedUp);
      return;
    }

    fn evolveTrafficLights(global_id: vec3<u32>) {
      var blockSize = arrayLength(&nodes) / 64u;
      var startIndex = global_id.x * blockSize;
      var endIndex = startIndex + blockSize;

      for (var i = startIndex; i < endIndex; i = i + 1u) {
        var node = nodes[i];
        if (node.signal == 2u) {
          nodeResults[i] = node;
          continue;
        }

        if (node.signal == 1u && node.ticks == node.redTickLimit) {
          node.signal = 0u;
          node.ticks = 0u;
        } else if (node.signal == 0u && node.ticks == node.greenTickLimit) {
          node.signal = 1u;
          node.ticks = 0u;
        }

        node.ticks = node.ticks + 1u;
        nodeResults[i] = node;
      }
    }
    `,
  });
}

let bindGroupLayout = null;
function createBindGroupLayout() {
  bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: 'read-only-storage',
        },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: 'read-only-storage',
        },
      },
      {
        binding: 2,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: 'read-only-storage',
        },
      },
      {
        binding: 3,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: 'storage',
        },
      },
      {
        binding: 4,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: 'read-only-storage',
        },
      },
      {
        binding: 5,
        visibility: GPUShaderStage.COMPUTE,
        buffer: {
          type: 'storage',
        },
      },
    ],
  });
}

let computePipeline = null;
function createComputePipeline() {
  computePipeline = device.createComputePipeline({
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    }),
    compute: {
      module: shaderModule,
      entryPoint: 'main',
    },
  });
}

let bindGroups = null;
function createBindGroup() {
  bindGroups = new Array(2);
  for (let i = 0; i < 2; ++i) {
    bindGroups[i] = device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: {
            buffer: waysBuffer,
          },
        },
        {
          binding: 1,
          resource: {
            buffer: connectionIdsBuffer,
          },
        },
        {
          binding: 2,
          resource: {
            buffer: nodesBuffers[i],
          },
        },
        {
          binding: 3,
          resource: {
            buffer: nodesBuffers[(i + 1) % 2],
          },
        },
        {
          binding: 4,
          resource: {
            buffer: carsBuffers[i],
            offset: 0,
            size: buildGpuCarsArray().byteLength,
          },
        },
        {
          binding: 5,
          resource: {
            buffer: carsBuffers[(i + 1) % 2],
            offset: 0,
            size: buildGpuCarsArray().byteLength,
          },
        },
      ],
    });
  }
}

async function setUpGpu() {
  await getDevice();
  initStaticBuffers();
  initCarsBuffers();
  createShaderModule();
  createBindGroupLayout();
  createComputePipeline();
  createBindGroup();
}

let t = 0;
async function computePassGpu() {
  const device = await getDevice();

  const startTime = performance.now();
  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginComputePass();
  passEncoder.setPipeline(computePipeline);
  passEncoder.setBindGroup(0, bindGroups[t % 2]);
  passEncoder.dispatchWorkgroups(Math.ceil(initialCarsSize / 64));
  passEncoder.end();

  // Get a GPU buffer for reading in an unmapped state.
  const gpuCarsReadBuffer = device.createBuffer({
    size: initialCarsByteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  // const gpuNodesReadBuffer = device.createBuffer({
  //   size: buildGpuNodesArray().byteLength,
  //   usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  // });

  // Encode commands for copying buffer to buffer.
  commandEncoder.copyBufferToBuffer(
    carsBuffers[(t + 1) % 2] /* source buffer */,
    0 /* source offset */,
    gpuCarsReadBuffer /* destination buffer */,
    0 /* destination offset */,
    initialCarsByteLength /* size */
  );
  // commandEncoder.copyBufferToBuffer(
  //   nodesBuffers[(t + 1) % 2] /* source buffer */,
  //   0 /* source offset */,
  //   gpuNodesReadBuffer /* destination buffer */,
  //   0 /* destination offset */,
  //   buildGpuNodesArray().byteLength /* size */
  // );

  // Submit GPU commands.
  device.queue.submit([commandEncoder.finish()]);

  // Read buffer.
  await gpuCarsReadBuffer.mapAsync(GPUMapMode.READ);
  // await gpuNodesReadBuffer.mapAsync(GPUMapMode.READ);
  const endTime = performance.now();
  gpuTimes.push(endTime - startTime);
  const arrayBuffer = gpuCarsReadBuffer.getMappedRange();
  // const arrayBufferNodes = gpuNodesReadBuffer.getMappedRange();
  // gpuNodes = buildCpuNodesArray(new Uint32Array(arrayBufferNodes));
  gpuCars = buildCpuCarsArray(new Uint32Array(arrayBuffer));
  t++;
}
