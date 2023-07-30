async function computePassCpu() {
  cars = cars
    .map((car) => {
      const way = ways.find((x) => x.id === car.wayId);
      const node = way.nodes.find((x) => x.id === car.nodeId);
      const index = way.nodes.indexOf(node);

      let currentWay = way;
      let positionInWay = index;
      let previousNode = node;
      let nextNode = previousNode;
      for (let distanceToCheck = 0; distanceToCheck < Math.max(car.speed, 1); distanceToCheck++) {
        if (positionInWay + 1 > currentWay.nodes.length - 1) {
          currentWay = currentWay.connections[0];
          positionInWay = 0;

          if (!currentWay) {
            return null;
          }
        }

        nextNode = currentWay.nodes[positionInWay + 1];
        const isCarOnNextNode = cars.find((x) => x.nodeId === nextNode.id);

        if (isCarOnNextNode) {
          return {
            lat: previousNode.lat,
            lon: previousNode.lon,
            wayId: previousNode.wayId,
            nodeId: previousNode.id,
            speed: distanceToCheck,
          };
        }

        previousNode = nextNode;
        positionInWay++;
      }

      return {
        lat: nextNode.lat,
        lon: nextNode.lon,
        wayId: nextNode.wayId,
        nodeId: nextNode.id,
        speed: Math.max(car.speed, 1),
      };
    })
    .filter(Boolean);
}
