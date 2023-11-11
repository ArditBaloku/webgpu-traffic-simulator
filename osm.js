const nodes = [];
let ways = [];

pbfParser.parse({
  filePath: 'prishtina.osm.pbf',
  node: function (node) {
    if (node.tags.crossing === 'traffic_signals' && node.tags.highway !== 'crossing') {
      node.signal = 'red';
    }
    nodes.push(node);
  },
  way: function (way) {
    ways.push(way);
  },
  error: function (msg) {
    console.error('error: ' + msg);
  },
  endDocument: function () {
    console.log('OSM parsed');
    preProcessRoads();
    setUpGpu().then(() => {
      ready = true;
    });
  },
});

function preProcessRoads() {
  // filter only roads that are tertiary, secondary or primary
  const allowedHighways = ['tertiary', 'secondary', 'primary'];
  ways = ways
    .filter((x) => x.tags.highway && allowedHighways.includes(x.tags.highway))
    .map((x) => ({
      ...x,
      nodes: x.nodeRefs.map((y) => ({ ...nodes.find((z) => z.id === y), wayId: x.id })),
      connections: [],
    }));

  // connect ways
  ways.forEach((way) => {
    const lastNode = way.nodes[way.nodes.length - 1];
    const connectingWays = ways.filter((x) => x.id !== way.id && x.nodes[0].id === lastNode.id);
    if (connectingWays.length) {
      way.connections.push(...connectingWays);
    }
  });

  console.log(ways.find((x) => x.id == '669157139'));

  // group up traffic lights and set their initial state
  const trafficLightNodes = ways.flatMap((x) => x.nodes).filter((x) => x.signal);
  const groupedTrafficLightNodes = groupTrafficLightNodes(trafficLightNodes);
  groupedTrafficLightNodes.forEach((group) => {
    let tickCounter = 0;
    let tickStep = Math.floor(60 / group.length);
    group.forEach((node, index) => {
      if (index === 0) {
        node.signal = 'green';
        node.ticks = 0;
      } else {
        node.signal = 'red';
        node.ticks = tickCounter;
        tickCounter += tickStep;
      }

      node.redTickLimit = tickStep * (group.length - 1);
      node.greenTickLimit = tickStep;
    });
  });

  // reassign way and node ids because they're too big for any typed array
  const nodeIdMap = {};
  let newWayId = 1;
  let newNodeId = 1;
  ways.forEach((way) => {
    way.oldId = way.id;
    way.id = newWayId++;

    way.nodes.forEach((node) => {
      node.wayId = way.id;
      node.oldId = node.id;

      if (nodeIdMap[node.id]) {
        node.id = nodeIdMap[node.id];
        return;
      }

      nodeIdMap[node.id] = newNodeId;
      node.id = newNodeId++;
    });
  });

  // generate cars
  const randomNodes = ways.flatMap((x) => x.nodes).filter((x) => Math.random() < 0.2);
  let id = 1;
  cpuCars = randomNodes.map((y) => ({
    id: id++,
    lat: y.lat,
    lon: y.lon,
    wayId: y.wayId,
    nodeId: y.id,
    speed: 2,
  }));
  gpuCars = JSON.parse(JSON.stringify(cpuCars));

  leftP5.cars = cpuCars;
  rightP5.cars = gpuCars;
}

// Helper function to calculate the distance between two nodes
// Based on the Haversine formula
function distance(node1, node2) {
  const R = 6371e3; // metres
  const φ1 = (node1.lat * Math.PI) / 180; // φ, λ in radians
  const φ2 = (node2.lat * Math.PI) / 180;
  const Δφ = ((node2.lat - node1.lat) * Math.PI) / 180;
  const Δλ = ((node2.lon - node1.lon) * Math.PI) / 180;

  const a =
    Math.sin(Δφ / 2) * Math.sin(Δφ / 2) +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) * Math.sin(Δλ / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c; // in metres
}

function groupTrafficLightNodes(nodes) {
  const groupedNodes = [];

  // Group nodes by distance
  nodes.forEach((node1) => {
    let group = null;

    for (let i = 0; i < groupedNodes.length; i++) {
      const node2 = groupedNodes[i][0];

      if (distance(node1, node2) < 60) {
        // 10 metres threshold
        group = groupedNodes[i];
        break;
      }
    }

    if (!group) {
      group = [];
      groupedNodes.push(group);
    }

    group.push(node1);
  });

  return groupedNodes;
}
