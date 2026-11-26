/**
 * Deterministic, offline advice engine.
 * Used when Gemini is not configured, fails, or gives ungrounded output, so the app always gives
 * safe, useful guidance. Returns the same shape as the AI response (see ADVICE_SCHEMA in prompt.js).
 * Every recommendation follows BAND_GUIDANCE so it never contradicts the safety level.
 */
import { BAND_GUIDANCE } from './aqi.js';
import { clock } from './prompt.js';

const SENSITIVE = {
  children: 'children',
  elderly: 'elderly family members',
  pregnant: 'anyone pregnant',
  'asthma-or-copd': 'anyone with asthma or COPD',
  'heart-condition': 'anyone with a heart condition',
};

const LEVEL_RANK = { good: 0, moderate: 1, sensitive: 2, unhealthy: 3, 'very-unhealthy': 4, hazardous: 5, unknown: 2 };

function listJoin(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function buildRoutine(air, profile, rank, sensitive) {
  const o = air.outlook ?? { improves: false };
  const best = air.cleanestHours.find((h) => h.aqi === o.bestAqi) ?? air.cleanestHours[0];
  const steps = [];

  if (rank <= 1) {
    steps.push({
      time: '6-8 AM',
      action: 'Go for your walk, run or yoga outside, away from main roads.',
      why: 'Air is clean enough today; staying 50-100 m from heavy traffic still cuts the exhaust you breathe noticeably.',
    });
  } else {
    steps.push({
      time: '6-9 AM',
      action: rank >= 4 ? 'Stay in and exercise indoors (yoga, stretching, stairs).' : 'Move your workout indoors or keep it short and gentle.',
      why: 'Winter mornings trap smog near the ground (temperature inversion), and hard breathing pulls more fine particles deep into the lungs.',
    });
  }

  if (best && o.improves) {
    steps.push({
      time: clock(best.time),
      action: `Do errands, school runs and air out your home now. AQI drops to about ${best.aqi}.`,
      why: `This is the cleanest hour in the next day, about ${o.drop} points better than now, so you breathe less pollution doing the same things.`,
    });
  } else if (rank >= 2) {
    steps.push({
      time: 'All day',
      action: 'Keep outdoor trips short and bundle errands into one trip.',
      why: "Air isn't forecast to improve in the next 24 hours, so total time outside is what you can control.",
    });
  }

  if (profile.commute === 'car') {
    steps.push({
      time: 'Commute',
      action: 'Keep windows up with air recirculation on, and car-pool or take the metro when you can.',
      why: 'Recirculation can cut in-cabin fine particles sharply in traffic, and every trip you share removes one car of exhaust from the road.',
    });
  } else if (profile.commute === 'two-wheeler' || profile.commute === 'walk' || profile.commute === 'cycle') {
    steps.push({
      time: 'Commute',
      action: rank >= 2 ? 'Wear a well-fitted N95 and take quieter side streets.' : 'Take quieter side streets where you can.',
      why: 'Riders and walkers breathe road exhaust directly; a sealed N95 filters about 95% of fine particles and side streets often have far less traffic smoke.',
    });
  } else if (profile.commute === 'public-transport' && rank >= 2) {
    steps.push({
      time: 'Commute',
      action: 'Wear an N95 while walking to and waiting at the station.',
      why: 'Roadside waiting is where metro and bus riders get most of their exposure.',
    });
  }

  steps.push({
    time: '6-10 PM',
    action:
      rank >= 2
        ? 'Close windows by sunset and skip incense, mosquito coils and any burning.'
        : 'Close windows at night if smoke from burning drifts in, and skip incense and mosquito coils.',
    why: 'Smog builds again as air cools at night, and indoor smoke adds fine particles right where you sleep.',
  });

  if (sensitive.length && rank >= 2) {
    steps.splice(1, 0, {
      time: 'Morning',
      action: `Keep ${listJoin(sensitive)} indoors and have any prescribed inhalers or medicines within reach.`,
      why: 'Sensitive groups react at lower pollution levels; being prepared turns a bad-air day into a manageable one.',
    });
  }
  return steps.slice(0, 5);
}

function buildIndoor(profile, rank) {
  const tips = [];
  if (rank >= 4) {
    tips.push({
      tip: 'Seal gaps around windows and doors with tape or a rolled wet towel, and make one "clean room" to sleep in.',
      why: 'At this level outdoor air leaking in is the biggest source of indoor pollution.',
      cost: 'free',
    });
  }
  if (rank >= 2) {
    tips.push(
      profile.hasPurifier
        ? {
            tip: 'Run your purifier on high in the room you sleep in, door closed. Clean or replace the filter on schedule.',
            why: 'A purifier works best in one closed room; a clogged filter can cut its output a lot.',
            cost: 'free',
          }
        : {
            tip: 'Make a DIY purifier: strap a MERV-13 filter to the back of a box or table fan and run it in the bedroom.',
            why: 'Studies show these cut indoor PM2.5 substantially for a fraction of a purifier price.',
            cost: 'low',
          },
    );
  } else {
    tips.push({
      tip: 'Open windows on opposite sides for 10-15 minutes to cross-ventilate.',
      why: 'When outdoor air is clean, fresh air flushes out cooking fumes, dust and CO₂ that build up indoors.',
      cost: 'free',
    });
  }
  tips.push(
    {
      tip: 'Switch on the kitchen chimney or exhaust fan before you start cooking and cover pots.',
      why: 'Cooking, especially frying and tadka, is one of the biggest indoor sources of fine particles.',
      cost: 'free',
    },
    {
      tip: 'Mop with a damp cloth instead of sweeping or dry dusting.',
      why: 'Sweeping throws settled fine dust back into the air you breathe.',
      cost: 'free',
    },
    {
      tip: 'Skip incense, mosquito coils and candles; use a mosquito net or electric repellent instead.',
      why: 'Burning one coil can release as much fine particle pollution as many cigarettes.',
      cost: 'free',
    },
  );
  return tips.slice(0, 5);
}

function buildSwaps(profile) {
  const swaps = [];
  if (profile.cooking === 'biomass' || profile.cooking === 'kerosene') {
    swaps.push({
      instead: profile.cooking === 'biomass' ? 'Cooking on wood or biomass' : 'Cooking on kerosene',
      try: 'LPG (PMUY connection if eligible), piped gas or induction',
      impact: 'Removes most of the smoke your family breathes at home and cuts soot your neighbours breathe too.',
      impactLevel: 'high',
    });
  }
  if (['wood', 'coal', 'kerosene'].includes(profile.heating)) {
    swaps.push({
      instead: `Heating with ${profile.heating}`,
      try: 'An oil-filled electric radiator, warm layers and draught-proofing',
      impact: 'Ends indoor smoke from heating and removes a nightly smoke source from your street.',
      impactLevel: 'high',
    });
  }
  if (profile.commute === 'car') {
    swaps.push({
      instead: 'Driving alone',
      try: 'Metro or bus, car-pooling, or an e-bike for trips under 5 km',
      impact: 'You avoid sitting in traffic exhaust, and each trip you switch removes NO₂ and PM2.5 from roads people walk along.',
      impactLevel: 'medium',
    });
  }
  if (profile.commute === 'two-wheeler') {
    swaps.push({
      instead: 'A petrol two-wheeler for short trips',
      try: 'Walking or cycling under 2 km, or an electric scooter',
      impact: 'Cuts tailpipe exhaust on crowded streets; electric scooters have no tailpipe at all.',
      impactLevel: 'medium',
    });
  }
  if (profile.heating === 'gas' || profile.cooking === 'lpg' || profile.cooking === 'piped-gas') {
    swaps.push({
      instead: 'Cooking without ventilation',
      try: 'Always run the chimney or open a window while the gas is on',
      impact: 'Gas flames still release NO₂; venting keeps it from building up indoors.',
      impactLevel: 'low',
    });
  }
  swaps.push({
    instead: 'Burning dry leaves or garbage',
    try: 'Compost leaves and hand waste to municipal collection',
    impact: 'Open burning releases dense smoke at street level where children walk and play.',
    impactLevel: 'medium',
  });
  return swaps.slice(0, 4);
}

export function buildRuleAdvice({ place, air }, profile) {
  const level = air.category.level;
  const rank = LEVEL_RANK[level] ?? 2;
  const guide = BAND_GUIDANCE[level] ?? BAND_GUIDANCE.unknown;
  const sensitive = profile.household.filter((h) => SENSITIVE[h]).map((h) => SENSITIVE[h]);

  const main = air.dominant ? `, mainly ${air.dominant.name.replace(/ \(.*\)$/, '')}` : '';
  const who = air.pm25WhoMultiple ? ` PM2.5 is about ${air.pm25WhoMultiple}× the WHO daily limit.` : '';
  const topAction =
    rank >= 4
      ? 'Stay indoors with windows closed and wear an N95 if you must go out.'
      : rank >= 2
        ? 'Keep exercise indoors and wear an N95 on busy roads.'
        : 'Enjoy time outside, away from busy roads.';

  const summary = `Air in ${place.name} is ${air.category.label} right now (AQI ${air.usAqi}${main}).${who} ${topAction}`;

  let riskNote;
  if (sensitive.length) {
    riskNote = `${listJoin(sensitive).replace(/^./, (c) => c.toUpperCase())} ${rank >= 2 ? 'should limit time outside today.' : 'should be fine, but watch for symptoms.'} See a doctor if anyone has breathlessness, chest tightness or wheezing that does not settle.`;
  } else if (rank >= 3) {
    riskNote = `Even healthy adults may get a sore throat, cough or tired eyes today. Outdoor exercise: ${guide.outdoorExercise}. See a doctor for breathlessness or chest pain.`;
  } else {
    riskNote = 'Low risk for healthy adults today. Children, older people and anyone with asthma should still avoid busy roads.';
  }

  return {
    summary,
    riskNote,
    routine: buildRoutine(air, profile, rank, sensitive),
    indoor: buildIndoor(profile, rank),
    alternatives: buildSwaps(profile),
    answer: profile.question
      ? "Our AI assistant is busy right now, so we couldn't answer your question. The plan above follows official safety guidance for today's air. Please try again in a minute."
      : '',
  };
}
