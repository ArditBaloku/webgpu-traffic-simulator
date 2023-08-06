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

  for (const way of ways) {
    const gpuWay = {
      id: Number(way.id),
      connectionsOffset: connectionsOffset,
      connectionsLength: way.connections.length,
      nodesOffset: nodesOffset,
      nodesLength: way.nodes.length,
      isRoundabout: way.tags.junction && way.tags.junction === 'roundabout' ? true : false,
    };

    gpuWays.push(gpuWay);
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
  return new Uint32Array(arr);
}

function buildGpuNodesArray() {
  const flatNode = ways.flatMap((x) => x.nodes);
  const nodeIdsArray = new Uint32Array(flatNode.flatMap((x) => [Number(x.id), Number(x.wayId)]));
  const nodeCoordsArray = new Float32Array(flatNode.flatMap((x) => [x.lat, x.lon]));
  return [nodeIdsArray, nodeCoordsArray];
}

waysBuffer = null;
nodeIdsBuffer = null;
nodeCoordsBuffer = null;
staticBuffersInitialized = false;
function initStaticBuffers() {
  if (staticBuffersInitialized) {
    return;
  }

  const gpuWaysArray = buildGpuWaysArray();
  waysBuffer = createGPUBuffer(
    gpuWaysArray,
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
    
    @group(0) @binding(0) var<storage, read> ways : Ways;
    @group(0) @binding(1) var<storage, read> nodeIds : NodeIds;
    @group(0) @binding(2) var<storage, read> nodeCoordinates : NodeCoordinates;
    
    @compute @workgroup_size(8)
    fn main(@builtin(global_invocation_id) global_id : vec3<u32>) {
      var index = global_id.x;
      // use these just to autodetect layout
      var way = ways.ways[index];
      var nodesOffset = way.nodesOffset;
      var nodeIds = nodeIds.nodeIds[nodesOffset];
      var nodeCoordinates = nodeCoordinates.nodeCoordinates[nodesOffset];
    }`,
  });

  shaderModuleCreated = true;
}

async function computePassGpu() {
  const device = await getDevice();
  initStaticBuffers();

  // Pipeline setup

  createShaderModule();
  const computePipeline = device.createComputePipeline({
    layout: 'auto',
    compute: {
      module: shaderModule,
      entryPoint: 'main',
    },
  });

  const bindGroup = device.createBindGroup({
    layout: computePipeline.getBindGroupLayout(0),
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
          buffer: nodeIdsBuffer,
        },
      },
      {
        binding: 2,
        resource: {
          buffer: nodeCoordsBuffer,
        },
      },
    ],
  });

  // Commands submission

  const commandEncoder = device.createCommandEncoder();

  const passEncoder = commandEncoder.beginComputePass();
  passEncoder.setPipeline(computePipeline);
  passEncoder.setBindGroup(0, bindGroup);
  passEncoder.dispatchWorkgroups(8);
  passEncoder.end();

  // Submit GPU commands.
  const gpuCommands = commandEncoder.finish();
  device.queue.submit([gpuCommands]);
}
