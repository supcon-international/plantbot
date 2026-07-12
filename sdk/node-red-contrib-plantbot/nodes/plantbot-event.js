// plantbot-event: raise a detection / robot-fault event. If the payload names
// a snapshotStream, the platform's evidence service grabs a frame from that
// registered stream first and the event carries the hosted snapshot URL.
'use strict'

module.exports = function (RED) {
  function PlantbotEventNode(config) {
    RED.nodes.createNode(this, config)
    const site = RED.nodes.getNode(config.site)
    const node = this
    if (!site) {
      node.status({ fill: 'red', shape: 'ring', text: 'no site config' })
      return
    }
    const pb = site.client

    node.on('input', async (msg, _send, done) => {
      const ev = { ...(msg.payload ?? {}) }
      if (!ev.type) {
        node.warn('event needs msg.payload.type (an event-type id from the site vocabulary)')
        done()
        return
      }
      if (ev.snapshotStream && !ev.snapshotUrl) {
        const snap = await pb.snapshot(ev.snapshotStream)
        if (snap.ok && snap.data?.url) ev.snapshotUrl = snap.data.url
        delete ev.snapshotStream
      }
      const r = await pb.event(ev)
      node.status(
        r.ok
          ? { fill: 'green', shape: 'dot', text: `event ${ev.type}` }
          : { fill: 'yellow', shape: 'ring', text: `failed (${r.status || 'offline'})` },
      )
      done()
    })
  }
  RED.nodes.registerType('plantbot-event', PlantbotEventNode)
}
