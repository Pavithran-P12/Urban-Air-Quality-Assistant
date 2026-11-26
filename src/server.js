import { createApp } from './app.js';
import { createGeminiAdvisor } from './gemini.js';

const port = Number(process.env.PORT) || 8080;
const advisor = createGeminiAdvisor({
  apiKey: process.env.GEMINI_API_KEY,
  model: process.env.GEMINI_MODEL || undefined,
});

if (!advisor) {
  console.warn('GEMINI_API_KEY not set: running with the offline rules engine only.');
}

createApp({ advisor }).listen(port, () => {
  console.log(`Urban Air Quality Assistant running on http://localhost:${port}`);
});
