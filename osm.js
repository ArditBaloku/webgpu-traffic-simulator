const bounds = [];
const nodes = [];
let ways = [];
const relations = [];
let coordinates = [];

pbfParser.parse({
  filePath: 'prishtina-lite.osm.pbf',
  node: function (node) {
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
    filterRoads();
    ready = true;
  },
  // bounds: function (bounds) {
  //   bounds.push(bounds);
  // },
  // relation: function (relation) {
  //   relations.push(relation);
  // },
});

function filterRoads() {
  const allowedHighways = ['tertiary', 'secondary', 'primary'];
  ways = ways
    .filter((x) => x.tags.highway && allowedHighways.includes(x.tags.highway))
    .map((x) => ({
      ...x,
      nodes: x.nodeRefs.map((y) => ({ ...nodes.find((z) => z.id === y), wayId: x.id })),
      connections: [],
    }));

  ways.forEach((way) => {
    const lastNode = way.nodes[way.nodes.length - 1];
    const lastWay = ways.find((x) => x.id !== way.id && x.nodes[0].id === lastNode.id);
    if (lastWay) {
      way.connections.push(lastWay);
    }
  });

  // reassign way and node ids because they're too big for any typed array
  const nodeIdMap = {};
  let newWayId = 1;
  let newNodeId = 1;
  ways.forEach((way) => {
    way.id = newWayId++;

    way.nodes.forEach((node) => {
      node.wayId = way.id;

      if (nodeIdMap[node.id]) {
        node.id = nodeIdMap[node.id];
        return;
      }

      nodeIdMap[node.id] = newNodeId;
      node.id = newNodeId++;
    });
  });

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
