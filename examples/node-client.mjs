import mqtt from "mqtt";

const client = await mqtt.connectAsync("mqtt://127.0.0.1:1883", {
  clientId: "pocketlab-example",
  protocolVersion: 4,
});

await client.subscribeAsync("pocketlab/devices/+/telemetry");
client.on("message", (topic, payload) => {
  console.log(topic, JSON.parse(payload.toString("utf8")));
});

console.log("Listening for virtual device telemetry. Press Ctrl+C to exit.");
