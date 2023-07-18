async function computePassCpu() {
  cars = cars
    .map((car) => {
      const way = ways.find((x) => x.id === car.wayId);
      const node = way.nodes.find((x) => x.id === car.nodeId);
      const index = way.nodes.indexOf(node);
      if (index > way.nodes.length - 2) {
        return null;
      }

      const nextNode = way.nodes[index + 1];
      return {
        lat: nextNode.lat,
        lon: nextNode.lon,
        wayId: nextNode.wayId,
        nodeId: nextNode.id,
      };
    })
    .filter(Boolean);
}
