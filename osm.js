const bounds = [];
const nodes = [];
let ways = [];
const relations = [];
let coordinates = [];

pbfParser.parse({
  filePath: 'rrugaB.osm.pbf',
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

  const randomNodes = ways.flatMap((x) => x.nodes).filter((x) => Math.random() < 0.2);
  let id = 1;
  cars = randomNodes.map((y) => ({
    id: id++,
    lat: y.lat,
    lon: y.lon,
    wayId: y.wayId,
    nodeId: y.id,
    speed: 2,
  }));
}
