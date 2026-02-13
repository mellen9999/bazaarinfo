import { Client } from '@tmi.js/chat'
import { loadStore } from './store'
import { handleCommand } from './commands'
import { checkCooldown } from './cooldown'

const CHANNEL = process.env.TWITCH_CHANNEL
const TOKEN = process.env.TWITCH_TOKEN
const USERNAME = process.env.TWITCH_USERNAME

if (!CHANNEL || !TOKEN || !USERNAME) {
  console.error('missing env: TWITCH_CHANNEL, TWITCH_TOKEN, TWITCH_USERNAME')
  process.exit(1)
}

await loadStore()

const client = new Client({
  channels: [CHANNEL],
  identity: {
    username: USERNAME,
    token: TOKEN,
  },
})

client.on('message', (channel, user, message) => {
  const userId = user.id ?? user.username ?? 'anon'
  if (!checkCooldown(userId)) return

  const response = handleCommand(message)
  if (response) {
    client.say(channel.name, response)
  }
})

client.on('ready', () => {
  console.log(`connected to #${CHANNEL}`)
})

client.connect()
console.log('bazaarinfo starting...')
