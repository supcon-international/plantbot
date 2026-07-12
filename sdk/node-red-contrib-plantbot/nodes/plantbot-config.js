// Config node: one per Plantbot site — base URL + site API key (pbk_…).
// The key lives in Node-RED's credential store, never in exported flows.
'use strict'
const { PlantbotClient } = require('./plantbot-client.js')

module.exports = function (RED) {
  function PlantbotConfigNode(config) {
    RED.nodes.createNode(this, config)
    this.baseUrl = config.baseUrl
    this.client = new PlantbotClient(config.baseUrl, this.credentials?.apiKey)
  }
  RED.nodes.registerType('plantbot-config', PlantbotConfigNode, {
    credentials: { apiKey: { type: 'password' } },
  })
}
