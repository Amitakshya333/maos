import 'dotenv/config';
import OpenAI from 'openai';

async function test() {
  const client = new OpenAI({
    apiKey: process.env.FREEMODEL_API_KEY,
    baseURL: 'https://api.freemodel.dev/v1',
    timeout: 120_000,
  });

  console.log('Making API call...');
  const response = await client.chat.completions.create({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Say hello in one sentence.' },
    ],
    temperature: 0.2,
  });

  console.log('\n--- Response type:', typeof response);
  console.log('--- Constructor:', response?.constructor?.name);
  console.log('--- Keys:', Object.keys(response));
  console.log('--- Has choices:', 'choices' in response);
  console.log('--- choices type:', typeof (response as any).choices);
  console.log('--- choices:', JSON.stringify((response as any).choices, null, 2));
  console.log('--- Full response:', JSON.stringify(response, null, 2).substring(0, 500));
}

test().catch(err => {
  console.error('Error:', err.message);
  console.error('Stack:', err.stack);
});
