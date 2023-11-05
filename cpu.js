async function computePassCpu() {
  const startTime = performance.now();
  cpuCars = cpuCars
    .map((car) => {
      const way = ways.find((x) => x.id === car.wayId);
      const node = way.nodes.find((x) => x.id === car.nodeId);
      const index = way.nodes.indexOf(node);

      let currentWay = way;
      let previousWay = way;
      let positionInWay = index;
      let previousNode = node;
      let nextNode = previousNode;
      let canSpeedUp = false;
      for (let distanceToCheck = 0; distanceToCheck < Math.max(car.speed, 1); distanceToCheck++) {
        if (previousNode.signal === 'red') {
          return {
            id: car.id,
            lat: previousNode.lat,
            lon: previousNode.lon,
            wayId: previousNode.wayId,
            nodeId: previousNode.id,
            speed: 0,
          };
        }

        if (positionInWay + 1 > currentWay.nodes.length - 1) {
          previousWay = currentWay;
          currentWay = currentWay.connections[0];
          positionInWay = 0;

          if (!currentWay) {
            return null;
          }

          const enteringRoundabout = currentWay.tags.junction && !previousWay.tags.junction;
          if (enteringRoundabout) {
            const previousSectionOfRoundabout = ways.find(
              (x) => x.tags.junction && x.connections.some((y) => y.id === currentWay.id)
            );

            // check if any car is inside currentWay
            const isCarInRoundabout = cpuCars.find(
              (x) => x.wayId === currentWay.id || x.wayId === previousSectionOfRoundabout.id
            );

            if (isCarInRoundabout) {
              return {
                id: car.id,
                lat: previousNode.lat,
                lon: previousNode.lon,
                wayId: previousNode.wayId,
                nodeId: previousNode.id,
                speed: 0,
              };
            }
          }
        }

        nextNode = currentWay.nodes[positionInWay + 1];
        const isCarOnNextNode = cpuCars.find(
          (x) => x.nodeId === nextNode.id && x.wayId === currentWay.id
        );

        if (isCarOnNextNode || nextNode.signal === 'red') {
          return {
            id: car.id,
            lat: previousNode.lat,
            lon: previousNode.lon,
            wayId: previousNode.wayId,
            nodeId: previousNode.id,
            speed: distanceToCheck,
          };
        }

        previousNode = nextNode;
        positionInWay++;

        // If on the last loop of the for loop, and the next node after that is open,
        // and we have not reached max speed yet (2), then we can speed up
        // Also ignoring cars with a speed of 0 because they are going to speed up anyway
        if (distanceToCheck === Math.max(car.speed, 1) - 1 && car.speed < 2 && car.speed > 0) {
          if (positionInWay + 1 > currentWay.nodes.length - 1) {
            currentWay = currentWay.connections[0];
            positionInWay = 0;

            if (!currentWay) {
              break;
            }
          }

          nextNode = currentWay.nodes[positionInWay + 1];
          const isCarOnNextNode = cpuCars.find((x) => x.nodeId === nextNode.id);

          if (!isCarOnNextNode) {
            canSpeedUp = true;
          }
        }
      }

      const speedUp = canSpeedUp ? 1 : 0;
      return {
        id: car.id,
        lat: nextNode.lat,
        lon: nextNode.lon,
        wayId: nextNode.wayId,
        nodeId: nextNode.id,
        speed: Math.max(car.speed, 1) + speedUp,
      };
    })
    .filter(Boolean);

  ways.forEach((way) => {
    way.nodes.forEach((node) => {
      if (!node.signal) {
        return;
      }

      if (node.signal === 'red' && node.ticks === node.redTickLimit) {
        node.signal = 'green';
        node.ticks = 0;
      } else if (node.signal === 'green' && node.ticks === node.greenTickLimit) {
        node.signal = 'red';
        node.ticks = 0;
      }

      node.ticks++;
    });
  });

  const endTime = performance.now();
  cpuTimes.push(endTime - startTime);
}
