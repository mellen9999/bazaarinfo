import { TwitchClient, getUserId } from './twitch'
import { loadStore } from './store'
import { handleCommand } from './commands'
import { checkCooldown } from './cooldown'

const CHANNEL = process.env.TWITCH_CHANNEL
const TOKEN = process.env.TWITCH_TOKEN
const CLIENT_ID = process.env.TWITCH_CLIENT_ID
const BOT_USERNAME = process.env.TWITCH_USERNAME

if (!CHANNEL || !TOKEN || !CLIENT_ID || !BOT_USERNAME) {
  console.error('missing env: TWITCH_CHANNEL, TWITCH_TOKEN, TWITCH_CLIENT_ID, TWITCH_USERNAME')
  process.exit(1)
}

await loadStore()

console.log('resolving user IDs...')
const botUserId = await getUserId(TOKEN, CLIENT_ID, BOT_USERNAME)
const channelUserId = await getUserId(TOKEN, CLIENT_ID, CHANNEL)
console.log(`bot: ${BOT_USERNAME} (${botUserId}), channel: ${CHANNEL} (${channelUserId})`)

const client = new TwitchClient(
  { token: TOKEN, clientId: CLIENT_ID, botUserId, botUsername: BOT_USERNAME, channelUserId, channel: CHANNEL },
  (userId, username, text) => {
    if (userId === botUserId) return
    if (!checkCooldown(userId)) return

    const response = handleCommand(text)
    if (response) {
      console.log(`[${username}] ${text} -> ${response.slice(0, 80)}...`)
      client.say(response)
    }
  },
)

client.connect()
console.log('bazaarinfo starting...')
