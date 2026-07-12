import { describe, expect, test } from 'bun:test'
import {
  isWeatherQuery, extractLocation, cToF, dewPointC, humidexC, windChillC,
  describeWmo, parseForecast, getWeatherLine, __setWeatherCacheForTest,
  type Wx, type GeoLoc,
} from './weather'

describe('isWeatherQuery', () => {
  test('strong keywords fire without a place', () => {
    expect(isWeatherQuery("what's the weather like")).toBe(true)
    expect(isWeatherQuery('whats the temperature in winnipeg right now, share in both C and F and include the humidex')).toBe(true)
    expect(isWeatherQuery('forecast for toronto')).toBe(true)
    expect(isWeatherQuery('hows the humidity')).toBe(true)
    expect(isWeatherQuery('what is the wind chill')).toBe(true)
    expect(isWeatherQuery('what temp is it can u tell now')).toBe(true)
    expect(isWeatherQuery('whats the temp')).toBe(true)
    expect(isWeatherQuery('how hot is it')).toBe(true)
    expect(isWeatherQuery('is it cold outside')).toBe(true)
  })
  test('weak keywords need an extracted place', () => {
    expect(isWeatherQuery('is it raining in seattle')).toBe(true)
    expect(isWeatherQuery('is it hot in phoenix')).toBe(true)
    expect(isWeatherQuery('whats the temp in denver')).toBe(true)
    expect(isWeatherQuery('temp ban him')).toBe(false)
    expect(isWeatherQuery('give him a temp mod role')).toBe(false)
    expect(isWeatherQuery('how hot is that build')).toBe(false)
    expect(isWeatherQuery('snow item build')).toBe(false)
    expect(isWeatherQuery('is it raining in the bazaar')).toBe(false)
  })
  test('bazaar/game talk never triggers', () => {
    expect(isWeatherQuery('best heated build for vanessa')).toBe(false)
    expect(isWeatherQuery('chilled dooley any good')).toBe(false)
    expect(isWeatherQuery('how hot is vanessa')).toBe(false)
    expect(isWeatherQuery('whats the meta in the bazaar')).toBe(false)
    expect(isWeatherQuery('cool item')).toBe(false)
  })
})

describe('extractLocation', () => {
  test('pulls the place, strips filler and unit noise', () => {
    expect(extractLocation('whats the temperature in Winnipeg right now, share in both C and F and include the humidex')).toBe('Winnipeg')
    expect(extractLocation('forecast for tomorrow in toronto')).toBe('toronto')
    expect(extractLocation('weather in new york city?')).toBe('new york city')
    expect(extractLocation('weather in london at 5pm')).toBe('london')
  })
  test('null when nothing place-shaped survives', () => {
    expect(extractLocation('whats the weather')).toBeNull()
    expect(extractLocation('weather in the bazaar')).toBeNull()
    expect(extractLocation('give it to me in celsius')).toBeNull()
    expect(extractLocation('weather in C')).toBeNull()
  })
})

describe('unit math', () => {
  test('cToF', () => {
    expect(cToF(0)).toBe(32)
    expect(cToF(100)).toBe(212)
    expect(cToF(-40)).toBe(-40)
  })
  test('dew point (Magnus)', () => {
    const td = dewPointC(30, 75)!
    expect(td).toBeGreaterThan(24)
    expect(td).toBeLessThan(26.5)
    expect(dewPointC(30, 0)).toBeNull()
    expect(dewPointC(30, 101)).toBeNull()
    expect(dewPointC(NaN, 50)).toBeNull()
  })
  test('humidex reports only when meaningful', () => {
    const h = humidexC(30, 75)!
    expect(h).toBeGreaterThanOrEqual(40)
    expect(h).toBeLessThanOrEqual(44)
    expect(humidexC(10, 50)).toBeNull() // too cold to report
    expect(humidexC(30, 0)).toBeNull() // unusable RH
  })
  test('wind chill only in its validity window', () => {
    const wc = windChillC(-20, 30)!
    expect(wc).toBeGreaterThanOrEqual(-34)
    expect(wc).toBeLessThanOrEqual(-31)
    expect(windChillC(15, 30)).toBeNull() // too warm
    expect(windChillC(-20, 2)).toBeNull() // calm
  })
  test('wmo codes', () => {
    expect(describeWmo(0)).toBe('clear')
    expect(describeWmo(95)).toBe('thunderstorm')
    expect(describeWmo(1234)).toBe('unknown conditions')
  })
})

describe('parseForecast', () => {
  const payload = {
    current: {
      temperature_2m: 31.2, relative_humidity_2m: 65, apparent_temperature: 38.1,
      weather_code: 2, wind_speed_10m: 15.4, is_day: 1,
    },
    daily: {
      temperature_2m_max: [33.0, 29.5], temperature_2m_min: [19.2, 17.8],
      precipitation_probability_max: [20, 55],
    },
  }
  test('parses a well-formed payload', () => {
    const wx = parseForecast(payload)!
    expect(wx.tempC).toBe(31.2)
    expect(wx.humidity).toBe(65)
    expect(wx.today).toEqual({ highC: 33.0, lowC: 19.2, precipPct: 20 })
    expect(wx.tomorrow).toEqual({ highC: 29.5, lowC: 17.8, precipPct: 55 })
  })
  test('null on malformed payloads', () => {
    expect(parseForecast(null)).toBeNull()
    expect(parseForecast({})).toBeNull()
    expect(parseForecast({ current: { temperature_2m: 'hot' } })).toBeNull()
  })
  test('survives missing daily block', () => {
    const wx = parseForecast({ current: payload.current })!
    expect(wx.today).toBeNull()
    expect(wx.tomorrow).toBeNull()
  })
})

describe('getWeatherLine', () => {
  const loc: GeoLoc = { name: 'Winnipeg', region: 'Manitoba', country: 'CA', lat: 49.88, lon: -97.15, timezone: 'America/Winnipeg' }
  const wx: Wx = {
    tempC: 31, feelsC: 38, humidity: 75, windKmh: 15, code: 2, isDay: true,
    today: { highC: 33, lowC: 19, precipPct: 20 },
    tomorrow: { highC: 29, lowC: 17, precipPct: 55 },
  }
  const q = 'whats the temperature in winnipeg right now, share in both C and F and include the humidex'

  test('formats real data with both units, humidex, and forecast', () => {
    const now = Date.now()
    __setWeatherCacheForTest('winnipeg', { ts: now, loc, wx })
    const line = getWeatherLine(q, now)
    expect(line).toContain('Winnipeg, Manitoba, CA')
    expect(line).toContain('31°C/88°F')
    expect(line).toContain('partly cloudy')
    expect(line).toMatch(/humidex 4[3-6]°C/)
    expect(line).toContain('today: high 33°C/91°F')
    expect(line).toContain('tomorrow:')
    expect(line).toContain('open-meteo.com')
    __setWeatherCacheForTest('winnipeg', null)
  })
  test('winter: wind chill instead of humidex', () => {
    const now = Date.now()
    __setWeatherCacheForTest('winnipeg', { ts: now, loc, wx: { ...wx, tempC: -20, feelsC: -30, humidity: 60, windKmh: 30, code: 73 } })
    const line = getWeatherLine(q, now)
    expect(line).toMatch(/wind chill -3[1-4]°C/)
    expect(line).not.toContain('humidex')
    __setWeatherCacheForTest('winnipeg', null)
  })
  test('honest fallbacks: no city / unknown place / lookup down / hard-stale', () => {
    const now = Date.now()
    expect(getWeatherLine('whats the weather', now)).toContain('ask which city')
    __setWeatherCacheForTest('narnia', { ts: now, loc: null, wx: null })
    expect(getWeatherLine('weather in narnia', now)).toContain('no such place')
    __setWeatherCacheForTest('narnia', null)
    __setWeatherCacheForTest('winnipeg', { ts: now, loc, wx: null })
    expect(getWeatherLine(q, now)).toContain('lookup is down')
    __setWeatherCacheForTest('winnipeg', { ts: now - 31 * 60_000, loc, wx })
    expect(getWeatherLine(q, now)).toBe('')
    __setWeatherCacheForTest('winnipeg', null)
  })
  test('non-weather queries inject nothing', () => {
    expect(getWeatherLine('best heated build for vanessa')).toBe('')
    expect(getWeatherLine('how hot is vanessa')).toBe('')
  })
})
