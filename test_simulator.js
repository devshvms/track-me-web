const http = require('http');

async function runSimulator() {
  console.log('Starting Broadcaster Simulator...');

  // 1. Start Session
  const startReq = await fetch('http://localhost:3000/api/track/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ durationMinutes: 15 })
  });
  
  const startData = await startReq.json();
  console.log('Session Started:', startData);
  const sessionId = startData.sessionId;

  // 2. Simulate location updates
  let lat = 40.7128;
  let lon = -74.0060;
  
  console.log(`\nOpen http://localhost:3000/live/${sessionId} in your browser to view the live tracking.\n`);

  setInterval(async () => {
    lat += 0.001;
    lon += 0.001;

    try {
      const res = await fetch(`http://localhost:3000/api/track/${sessionId}/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lat,
          lon,
          batteryLevel: 85,
          speed: 25,
          heading: 90,
          timestamp: new Date().toISOString()
        })
      });
      
      const data = await res.json();
      console.log('Pushed location:', { lat, lon }, data);
    } catch (err) {
      console.error('Failed to push location', err.message);
    }
  }, 5000);
}

runSimulator();
