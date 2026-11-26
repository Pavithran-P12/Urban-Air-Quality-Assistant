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

/** Fake fetch that routes by URL. Records calls for assertions. */
export function mockFetch({ geocode = geocodeResponse, air = airResponse, fail = false, status = 200 } = {}) {
  const calls = [];
  const impl = async (url) => {
    calls.push(String(url));
    if (fail) throw new Error('network down');
    const body = String(url).includes('geocoding') ? geocode : air;
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
