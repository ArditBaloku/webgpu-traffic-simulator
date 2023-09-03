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
  const nodeIdsArray = new Uint32Array(flatNode.flatMap((x) => [x.id, x.wayId]));
  const nodeCoordsArray = new Float32Array(flatNode.flatMap((x) => [x.lat, x.lon]));
  return [nodeIdsArray, nodeCoordsArray];
}

function buildGpuCarsArray() {
  const gpuCarsFloatArray = new Float32Array(gpuCars.flatMap((x) => [x.lat, x.lon]));
  const gpuCarsUintArray = new Uint32Array(
    gpuCars.flatMap((x) => [x.id, x.wayId, x.nodeId, x.speed])
  );
  return [gpuCarsFloatArray, gpuCarsUintArray];
}

function buildCpuCarsArray(carUintArray, carFloatArray) {
  const cars = [];
  let offset = 0;
  for (let i = 0; i < carUintArray.length; i += 4) {
    if (carUintArray[i] === 0) {
      offset += 2;
      continue;
    }

    cars.push({
      id: carUintArray[i],
      wayId: carUintArray[i + 1],
      nodeId: carUintArray[i + 2],
      speed: carUintArray[i + 3],
      lat: carFloatArray[offset],
      lon: carFloatArray[offset + 1],
    });

    offset += 2;
  }
  return cars;
}

waysBuffer = null;
connectionIdsBuffer = null;
nodeIdsBuffer = null;
nodeCoordsBuffer = null;
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

  const [gpuNodeIdsArray, gpuNodeCoordsArray] = buildGpuNodesArray();
  nodeIdsBuffer = createGPUBuffer(
    gpuNodeIdsArray,
    GPUBufferUsage.STORAGE | GPUBufferUsage.READ | GPUBufferUsage.COPY_SRC
  );
  nodeCoordsBuffer = createGPUBuffer(
    gpuNodeCoordsArray,
    GPUBufferUsage.STORAGE | GPUBufferUsage.READ | GPUBufferUsage.COPY_SRC
  );

  staticBuffersInitialized = true;
}

carsFloatBuffer = null;
carsUintBuffer = null;
carsFloatResultsBuffer = null;
carsUintResultsBuffer = null;
function initCarsBuffers() {
  const [gpuCarsFloatArray, gpuCarsUintArray] = buildGpuCarsArray();
  carsFloatBuffer = createGPUBuffer(
    gpuCarsFloatArray,
    GPUBufferUsage.STORAGE | GPUBufferUsage.READ | GPUBufferUsage.COPY_SRC
  );
  carsUintBuffer = createGPUBuffer(
    gpuCarsUintArray,
    GPUBufferUsage.STORAGE | GPUBufferUsage.READ | GPUBufferUsage.COPY_SRC
  );

  carsFloatResultsBuffer = createGPUBuffer(
    gpuCarsFloatArray,
    GPUBufferUsage.STORAGE | GPUBufferUsage.READ | GPUBufferUsage.COPY_SRC
  );
  carsUintResultsBuffer = createGPUBuffer(
    gpuCarsUintArray,
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
    
    struct Ways {
      ways: array<Way>,
    }

    struct NodeId {
      id: u32,
      wayId: u32,
    }

    struct NodeCoordinate {
      lat: f32,
      lon: f32,
    }

    struct NodeIds {
      nodeIds: array<NodeId>,
    }

    struct NodeCoordinates {
      nodeCoordinates: array<NodeCoordinate>,
    }

    struct CarUint {
      id: u32,
      wayId: u32,
      nodeId: u32,
      speed: u32,
    }

    struct CarUints {
      carUints: array<CarUint>,
    }

    struct CarFloat {
      lat: f32,
      lon: f32,
    }

    struct CarFloats {
      carFloats: array<CarFloat>,
    }
    
    @group(0) @binding(0) var<storage, read> ways : Ways;
    @group(0) @binding(1) var<storage, read> connectionIds: array<u32>;
    @group(0) @binding(2) var<storage, read> nodeIds : NodeIds;
    @group(0) @binding(3) var<storage, read> nodeCoordinates : NodeCoordinates;
    @group(0) @binding(4) var<storage, read> carUints : CarUints;
    @group(0) @binding(5) var<storage, read> carFloats : CarFloats;
    @group(0) @binding(6) var<storage, read_write> carsUintResults : CarUints;
    @group(0) @binding(7) var<storage, read_write> carsFloatResults : CarFloats;
    
    @compute @workgroup_size(8)
    fn main(@builtin(global_invocation_id) global_id : vec3<u32>) {
      var index = global_id.x;
      var carUint = carUints.carUints[index];
      var carFloat = carFloats.carFloats[index];
      var way : Way;
      var nodeId : NodeId;
      var nodeCoordinate : NodeCoordinate;
      var nodeIndex : u32;

      for (var i = 0u; i < arrayLength(&ways.ways); i = i + 1u) {
        if (ways.ways[i].id == carUint.wayId) {
          way = ways.ways[i];
          break;
        }
      }

      for (var i = way.nodesOffset; i < way.nodesOffset + way.nodesLength; i = i + 1u) {
        if (nodeIds.nodeIds[i].id == carUint.nodeId) {
          nodeId = nodeIds.nodeIds[i];
          nodeCoordinate = nodeCoordinates.nodeCoordinates[i];
          nodeIndex = i - way.nodesOffset;
          break;
        }
      }

      var currentWay = way;
      var previousWay = way;
      var positionInWay = nodeIndex;
      var previousNodeId = nodeId;
      var previousNodeCoordinate = nodeCoordinate;
      var nextNodeId = previousNodeId;
      var nextNodeCoordinate = previousNodeCoordinate;
      var canSpeedUp = false;
      for (var distanceToCheck = 0u; distanceToCheck < max(carUint.speed, 1); distanceToCheck = distanceToCheck + 1u) {
        if (positionInWay + 1 > currentWay.nodesLength - 1) {
          if (currentWay.connectionsLength == 0u) {
            carsUintResults.carUints[index] = CarUint(0u, 0u, 0u, 0u);
            carsFloatResults.carFloats[index] = CarFloat(0.0, 0.0);
            return;
          }

          previousWay = currentWay;
          var currentWayId = connectionIds[currentWay.connectionsOffset];

          var foundCurrentWay = false;
          for (var i = 0u; i < arrayLength(&ways.ways); i = i + 1u) {
            if (ways.ways[i].id == currentWayId) {
              currentWay = ways.ways[i];
              foundCurrentWay = true;
              break;
            }
          }

          if (!foundCurrentWay) {
            carsUintResults.carUints[index] = CarUint(0u, 0u, 0u, 0u);
            carsFloatResults.carFloats[index] = CarFloat(0.0, 0.0);
            return;
          }

          var enteringRoundabout = currentWay.isRoundabout == 1u && previousWay.isRoundabout == 0u;
          if (enteringRoundabout) {
            var previousSectionOfRoundabout = Way(0u, 0u, 0u, 0u, 0u, 0u);
            for (var i = 0u; i < arrayLength(&ways.ways); i = i + 1u) {
              if (ways.ways[i].isRoundabout == 1u && ways.ways[i].connectionsLength != 0u && connectionIds[ways.ways[i].connectionsOffset] == currentWay.id) {
                previousSectionOfRoundabout = ways.ways[i];
                break;
              }
            }

            var isCarInRoundabout = false;
            for (var i = 0u; i < arrayLength(&carUints.carUints); i = i + 1u) {
              if (carUints.carUints[i].wayId == currentWay.id || carUints.carUints[i].wayId == previousSectionOfRoundabout.id) {
                isCarInRoundabout = true;
                break;
              }
            }

            if (isCarInRoundabout) {
              carsUintResults.carUints[index] = CarUint(carUint.id, previousNodeId.wayId, previousNodeId.id, 0);
              carsFloatResults.carFloats[index] = CarFloat(previousNodeCoordinate.lat, previousNodeCoordinate.lon);
              return;
            }
          }
        }

        nextNodeId = nodeIds.nodeIds[currentWay.nodesOffset + positionInWay + 1];
        nextNodeCoordinate = nodeCoordinates.nodeCoordinates[currentWay.nodesOffset + positionInWay + 1];
        var isCarOnNextNode = false;
        for (var i = 0u; i < arrayLength(&carUints.carUints); i = i + 1u) {
          if (carUints.carUints[i].nodeId == nextNodeId.id && carUints.carUints[i].wayId == currentWay.id) {
            isCarOnNextNode = true;
            break;
          }
        }

        if (isCarOnNextNode) {
          carsUintResults.carUints[index] = CarUint(carUint.id, previousNodeId.wayId, previousNodeId.id, distanceToCheck);
          carsFloatResults.carFloats[index] = CarFloat(previousNodeCoordinate.lat, previousNodeCoordinate.lon);
          return;
        }

        previousNodeId = nextNodeId;
        previousNodeCoordinate = nextNodeCoordinate;
        positionInWay = positionInWay + 1u;

        if (distanceToCheck == max(carUint.speed, 1) - 1u && carUint.speed < 2 && carUint.speed > 0) {
          if (positionInWay + 1 > currentWay.nodesLength - 1) {
            var currentWayId = connectionIds[currentWay.connectionsOffset];
            positionInWay = 0;
            
            if (currentWay.connectionsLength == 0u) {
              break;
            }

            var foundCurrentWay = false;
            for (var i = 0u; i < arrayLength(&ways.ways); i = i + 1u) {
              if (ways.ways[i].id == currentWayId) {
                currentWay = ways.ways[i];
                foundCurrentWay = true;
                break;
              }
            }

            if (!foundCurrentWay) {
              break;
            }

            nextNodeId = nodeIds.nodeIds[currentWay.nodesOffset + positionInWay + 1];
            nextNodeCoordinate = nodeCoordinates.nodeCoordinates[currentWay.nodesOffset + positionInWay + 1];

            var isCarOnNextNode = false;
            for (var i = 0u; i < arrayLength(&carUints.carUints); i = i + 1u) {
              if (carUints.carUints[i].nodeId == nextNodeId.id) {
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

      carsUintResults.carUints[index] = CarUint(carUint.id, nextNodeId.wayId, nextNodeId.id, max(carUint.speed, 1) + speedUp);
      carsFloatResults.carFloats[index] = CarFloat(nextNodeCoordinate.lat, nextNodeCoordinate.lon);
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

  const entries = [
    waysBuffer,
    connectionIdsBuffer,
    nodeIdsBuffer,
    nodeCoordsBuffer,
    carsUintBuffer,
    carsFloatBuffer,
    carsUintResultsBuffer,
    carsFloatResultsBuffer,
  ].map((buffer, index) => ({
    binding: index,
    resource: {
      buffer,
    },
  }));
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
  const [gpuCarsFloatArray, gpuCarsUintArray] = buildGpuCarsArray();

  const gpuCarUintReadBuffer = device.createBuffer({
    size: gpuCarsUintArray.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const gpuCarFloatReadBuffer = device.createBuffer({
    size: gpuCarsFloatArray.byteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  // Encode commands for copying buffer to buffer.
  commandEncoder.copyBufferToBuffer(
    carsUintResultsBuffer /* source buffer */,
    0 /* source offset */,
    gpuCarUintReadBuffer /* destination buffer */,
    0 /* destination offset */,
    gpuCarsUintArray.byteLength /* size */
  );
  commandEncoder.copyBufferToBuffer(
    carsFloatResultsBuffer /* source buffer */,
    0 /* source offset */,
    gpuCarFloatReadBuffer /* destination buffer */,
    0 /* destination offset */,
    gpuCarsFloatArray.byteLength /* size */
  );

  // Submit GPU commands.
  const gpuCommands = commandEncoder.finish();
  device.queue.submit([gpuCommands]);

  // Read buffer.
  await gpuCarUintReadBuffer.mapAsync(GPUMapMode.READ);
  await gpuCarFloatReadBuffer.mapAsync(GPUMapMode.READ);
  const arrayBuffer = gpuCarUintReadBuffer.getMappedRange();
  const arrayBufferFloat = gpuCarFloatReadBuffer.getMappedRange();
  gpuCars = buildCpuCarsArray(new Uint32Array(arrayBuffer), new Float32Array(arrayBufferFloat));
  // convert back to cars
}
