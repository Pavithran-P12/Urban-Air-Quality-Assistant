export const geocodeResponse = {
  results: [{ name: 'Delhi', admin1: 'Delhi', country: 'India', latitude: 28.65, longitude: 77.23, timezone: 'Asia/Kolkata' }],
};

const hours = Array.from({ length: 48 }, (_, i) => {
  const d = new Date(Date.UTC(2026, 10, 26, 0, 0) + i * 3600_000);
  return d.toISOString().slice(0, 16);
});

export const airResponse = {
  current: {
    time: '2026-11-26T10:00',
    us_aqi: 245,
    pm2_5: 180.4,
    pm10: 260.1,
    nitrogen_dioxide: 60.2,
    ozone: 20.5,
    carbon_monoxide: 1500,
    us_aqi_pm2_5: 245,
    us_aqi_pm10: 150,
    us_aqi_nitrogen_dioxide: 40,
    us_aqi_ozone: 15,
    us_aqi_carbon_monoxide: 12,
  },
  hourly: {
    time: hours,
    us_aqi: hours.map((_, i) => (i === 14 ? 120 : i === 15 ? 130 : i === 16 ? 140 : 250)),
  },
};

export const weatherResponse = {
  utc_offset_seconds: 19800,
  timezone: 'Asia/Kolkata',
  current: { temperature_2m: 18.5, wind_speed_10m: 4.2 },
  hourly: {
    time: hours,
    wind_speed_10m: hours.map((_, i) => (i === 14 ? 14 : 5)),
    precipitation_probability: hours.map((_, i) => (i === 20 ? 40 : 5)),
  },
};

/** Trimmed air-data function response (Google Air Quality API, 500 m). Times are UTC. */
export const googleResponse = {
  provider: 'google',
  resolutionM: 500,
  regionCode: 'in',
  current: {
    dateTime: '2026-11-26T04:30:00Z',
    localIndex: { code: 'ind_cpcb', name: 'AQI (IN)', aqi: 312, category: 'Very poor air quality', dominant: 'pm25' },
    pollutants: [
      { code: 'pm25', value: 150.2, units: 'MICROGRAMS_PER_CUBIC_METER' },
      { code: 'pm10', value: 240, units: 'MICROGRAMS_PER_CUBIC_METER' },
      { code: 'no2', value: 30, units: 'PARTS_PER_BILLION' },
      { code: 'o3', value: 10, units: 'PARTS_PER_BILLION' },
      { code: 'co', value: 1200, units: 'PARTS_PER_BILLION' },
      { code: 'so2', value: 4, units: 'PARTS_PER_BILLION' },
    ],
  },
  hourly: Array.from({ length: 48 }, (_, i) => ({
    dateTime: new Date(Date.UTC(2026, 10, 26, 5 + i, 0)).toISOString(),
    localAqi: 300,
    pollutants: [{ code: 'pm25', value: i === 6 ? 30 : 160, units: 'MICROGRAMS_PER_CUBIC_METER' }],
  })),
};

/**
 * Fake fetch that routes by URL. Records calls for assertions.
 * `google` is the air-data function response (null → that call fails).
 */
export function mockFetch({
  geocode = geocodeResponse,
  air = airResponse,
  weather = weatherResponse,
  google = null,
  fail = false,
  status = 200,
} = {}) {
  const calls = [];
  const impl = async (url) => {
    const u = String(url);
    calls.push(u);
    if (fail) throw new Error('network down');
    if (u.includes('air-data')) {
      return google ? { ok: true, status: 200, json: async () => google } : { ok: false, status: 503, json: async () => ({}) };
    }
    const body = u.includes('geocoding') ? geocode : u.includes('api.open-meteo.com/v1/forecast') ? weather : air;
    return { ok: status < 400, status, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}

/** A complete, grounded advice object (AQI values match airResponse). */
export const goodAdvice = {
  summary: 'Air is Very Unhealthy (AQI 245), mainly PM2.5. Stay indoors.',
  riskNote: 'Keep kids in.',
  routine: [
    { time: '7-9 AM', action: 'Exercise indoors', why: 'Inversion traps smog' },
    { time: '2 PM', action: 'Run errands at AQI 120', why: 'Cleanest hour' },
  ],
  indoor: [
    { tip: 'Damp mop', why: 'Less dust', cost: 'free' },
    { tip: 'Box-fan filter', why: 'Cuts PM2.5', cost: 'low' },
  ],
  alternatives: [{ instead: 'Driving', try: 'Metro', impact: 'Less exhaust', impactLevel: 'medium' }],
  answer: '',
};
