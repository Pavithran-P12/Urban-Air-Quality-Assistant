/**
 * Deterministic, offline advice engine.
 * Used when Gemini is not configured or fails, so the app always gives safe, useful guidance.
 * Returns the same shape as the AI response (see ADVICE_SCHEMA in prompt.js).
 */

const SENSITIVE = ['children', 'elderly', 'pregnant', 'asthma-or-copd', 'heart-condition'];

function hourLabel(iso) {
  const h = Number(iso?.slice(11, 13));
  if (!Number.isFinite(h)) return 'later today';
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${h % 12 || 12} ${suffix}`;
}

export function buildRuleAdvice({ place, air }, profile) {
  const aqi = air.usAqi;
  const level = air.category.level;
  const bad = aqi > 100;
  const veryBad = aqi > 200;
  const sensitive = profile.household.filter((h) => SENSITIVE.includes(h));
  const best = air.cleanestHours[0];
  const bestText = best ? `${hourLabel(best.time)} (AQI ${best.aqi})` : 'when AQI is lowest';

  const routine = [];
  routine.push({
    time: 'Morning',
    action: bad
      ? 'Skip outdoor exercise at dawn; smog is usually trapped near the ground early in winter. Exercise indoors.'
      : 'A short outdoor walk is fine. Avoid busy roads.',
    why: 'Winter temperature inversions trap pollutants close to the ground in the early morning.',
  });
  routine.push({
    time: best ? hourLabel(best.time) : 'Cleanest hour',
    action: `Do errands, school runs and ventilation around ${bestText}.`,
    why: 'Planning around the cleanest hour cuts how much polluted air you breathe without changing what you do.',
  });
  if (profile.commute === 'car' || profile.commute === 'two-wheeler') {
    routine.push({
      time: 'Commute',
      action: 'Use public transport or car-pool at least 2 days a week; keep car windows closed with recirculation on.',
      why: 'Every car trip you skip removes exhaust (NO₂ and PM2.5) from your street, and recirculation lowers in-cabin exposure.',
    });
  } else if (bad && (profile.commute === 'walk' || profile.commute === 'cycle')) {
    routine.push({
      time: 'Commute',
      action: 'Take side streets instead of main roads and wear a well-fitted N95/FFP2 mask.',
      why: 'Pollution can be much lower just one street away from heavy traffic; a sealed N95 filters most PM2.5.',
    });
  }
  routine.push({
    time: 'Evening',
    action: 'Close windows after sunset and avoid burning anything (waste, leaves, incense, mosquito coils).',
    why: 'Smog builds up again in the evening as the air cools, and burning adds fine particles at home.',
  });

  const indoor = [
    {
      tip: profile.hasPurifier
        ? 'Run your purifier on high in the bedroom with the door closed, and clean or replace the filter on schedule.'
        : 'Build a DIY purifier: tape a MERV-13 furnace filter to the back of a box fan.',
      why: 'A HEPA/MERV-13 filter in a closed room can cut indoor PM2.5 sharply; a box-fan filter costs a fraction of a purifier.',
    },
    {
      tip: 'Mop floors with a damp cloth instead of sweeping or dry dusting.',
      why: 'Sweeping kicks settled fine dust back into the air you breathe.',
    },
    {
      tip: 'Use the kitchen chimney/exhaust fan every time you cook and keep a lid on pots.',
      why: 'Cooking, especially frying, is one of the biggest indoor sources of fine particles.',
    },
  ];
  if (veryBad) {
    indoor.unshift({
      tip: 'Seal gaps around windows and doors with tape or wet towels, and keep one "clean room" for sleeping.',
      why: 'At this level, outdoor air leaking in is the main source of indoor pollution.',
    });
  }

  const alternatives = [];
  if (profile.cooking === 'biomass' || profile.cooking === 'kerosene') {
    alternatives.push({
      instead: `Cooking with ${profile.cooking}`,
      try: 'LPG, piped gas or an induction cooktop',
      impact: 'Solid-fuel and kerosene cooking is a major cause of household air pollution; switching removes most indoor smoke.',
    });
  }
  if (['wood', 'coal', 'kerosene'].includes(profile.heating)) {
    alternatives.push({
      instead: `Heating with ${profile.heating}`,
      try: 'An oil-filled electric radiator, warm layers and draught-proofing',
      impact: 'Removes smoke inside your home and cuts emissions your neighbours breathe.',
    });
  }
  if (profile.commute === 'car') {
    alternatives.push({
      instead: 'Driving alone',
      try: 'Metro/bus, car-pool, or an e-bike for short trips',
      impact: 'A typical short car trip emits several hundred grams of CO₂ plus NO₂ and PM2.5 at street level.',
    });
  }
  alternatives.push({
    instead: 'Burning dry leaves or garbage',
    try: 'Compost leaves and hand over waste to collection',
    impact: 'Open burning releases dense smoke right where people live and walk.',
  });

  const groups = sensitive.length ? sensitive.join(', ').replace(/-/g, ' ') : null;
  const summary =
    `Air in ${place.name} is "${air.category.label}" right now (US AQI ${aqi}` +
    (air.pm25WhoMultiple ? `, PM2.5 about ${air.pm25WhoMultiple}× the WHO daily guideline` : '') +
    `). ` +
    (bad ? 'Limit time outdoors and plan around the cleanest hours.' : 'Normal activities are fine for most people.');

  const riskNote = groups
    ? `Your household includes ${groups}. ${bad ? 'They should stay indoors as much as possible today and keep any prescribed inhalers or medicines handy.' : 'Keep an eye on symptoms like coughing or breathlessness.'} Seek medical help if breathing becomes difficult.`
    : level === 'good' || level === 'moderate'
      ? 'Low risk for healthy adults today.'
      : 'Even healthy adults may feel irritation today. Reduce long or intense outdoor activity.';

  return {
    summary,
    riskNote,
    routine,
    indoor,
    alternatives,
    answer: profile.question
      ? 'AI answers are not available right now, so here is general guidance based on current air quality. Ask again later for a personalised answer.'
      : '',
  };
}
