// Echo Deck proxy: signed-in, approved users reach Claude and ElevenLabs through here.
// The API keys live only in this function's secrets, and prompts are built server-side,
// so a user's token can make flashcards and audio, not arbitrary Claude calls.
// Secrets: ANTHROPIC_API_KEY, ELEVENLABS_API_KEY (Supabase's own URL and server key are built in).
// Deploy with "Verify JWT" off: this function checks the user itself, which also works with new JWT signing keys.
import { createClient } from 'npm:@supabase/supabase-js@2.118.0';
import Anthropic from 'npm:@anthropic-ai/sdk@1.3.0';

// New projects expose sb_secret_ keys as a JSON dict; older ones the legacy service-role key.
const serverKey = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}').default ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const db = createClient(Deno.env.get('SUPABASE_URL')!, serverKey);
const claude = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
const EL_KEY = Deno.env.get('ELEVENLABS_API_KEY')!;

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type, x-client-info',
  'access-control-allow-methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
const fail = (status: number, error: string) => json({ error }, status);
// Untrusted input -> bounded string.
const str = (x: unknown, max: number) => String(x ?? '').slice(0, max);

const CARDS_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['cards'],
  properties: { cards: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['target', 'native'],
    properties: { target: { type: 'string' }, native: { type: 'string' } },
  } } },
};

type Body = Record<string, unknown>;
const PROMPTS: Record<string, (b: Body, t: string, n: string) => string> = {
  translate: (b, t, n) => `Translate into natural spoken ${t}, as one card. ${n}: ${str(b.text, 500)}`,
  shadow: (b, t, n) => `A ${n} speaker shadowed a ${t} podcast out loud and went silent (lost the speaker) during these sentences. They were auto-transcribed, so they may contain errors:
${str(b.hard, 8000)}

Transcript of what the learner actually said during the whole session:
${str(b.mine, 20000) || '(nothing recognisable)'}

Turn what they struggled with into spoken production flashcards, prioritising phrases missing or garbled in their transcript.
Fix transcription errors, keep the speaker's natural phrasing, and split anything longer than ~14 words into shorter natural sentences.
Skip filler and fragments with no learning value. "target" is the ${t} sentence, "native" a natural ${n} translation.`,
};
const QUOTA: Record<string, string> = { translate: 'cards', shadow: 'cards', tts: 'tts', stt: 'stt' };

async function cards(prompt: string) {
  const msg = await claude.beta.messages.create({
    model: 'claude-opus-5-5', max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: CARDS_SCHEMA } },
    messages: [{ role: 'user', content: prompt }],
  } as any);
  if (msg.stop_reason === 'refusal') return fail(422, 'Claude declined this request');
  const text = msg.content.findLast((b: { type: string }) => b.type === 'text') as { text: string };
  return json(JSON.parse(text.text));
}

// Voice Library search. Voices that cost extra credits (a multiplier or custom rate) are left out.
// ponytail: tts still accepts any voice ID; look the voice up there too if people send pricier ones directly.
async function voices(b: Body) {
  const q = new URLSearchParams({ page_size: '30', sort: 'usage_character_count_1y' });
  for (const k of ['language', 'accent', 'gender', 'age', 'search', 'page']) if (b[k] != null && b[k] !== '') q.set(k, str(b[k], 100));
  const r = await fetch(`https://api.elevenlabs.io/v1/shared-voices?${q}`, { headers: { 'xi-api-key': EL_KEY } });
  if (!r.ok) return pass(r);
  const { voices = [], has_more } = await r.json();
  return json({
    has_more,
    voices: voices.filter((v: any) => (v.rate ?? 1) <= 1 && !v.fiat_rate).map((v: any) => ({
      voice_id: v.voice_id, name: v.name, gender: v.gender, age: v.age, accent: v.accent, use_case: v.use_case,
      description: v.description, preview_url: v.preview_url, verified_languages: v.verified_languages,
    })),
  });
}

// Stream ElevenLabs' response straight back (audio or JSON).
const pass = (r: Response) =>
  new Response(r.body, { status: r.status, headers: { ...cors, 'content-type': r.headers.get('content-type') ?? 'application/octet-stream' } });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  try {
    const task = new URL(req.url).searchParams.get('task') ?? '';
    if (!QUOTA[task] && task !== 'voices') return fail(400, 'Unknown task');
    const { data: { user } } = await db.auth.getUser(req.headers.get('authorization')?.replace('Bearer ', '') ?? '');
    if (!user) return fail(401, 'Please sign in again');
    // ponytail: searching voices spends no credits, so any signed-in user may; gate it on approval if it gets abused.
    if (task === 'voices') return await voices(await req.json());
    const { data: ok, error } = await db.rpc('echo_use_quota', { p_uid: user.id, p_task: QUOTA[task] });
    if (error) throw error;
    if (ok === null) return fail(403, 'Your account is waiting for approval');
    if (!ok) return fail(429, `Daily limit reached (${QUOTA[task]}). Try again tomorrow.`);

    // Multipart (file or source_url) streamed through untouched; the key is the only thing added.
    // ponytail: no size cap; whole-podcast uploads are bounded by the function's wall-clock limit.
    if (task === 'stt') return pass(await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST', body: req.body, duplex: 'half',
      headers: { 'xi-api-key': EL_KEY, 'content-type': req.headers.get('content-type') ?? '' },
    } as RequestInit));

    const b: Body = await req.json();
    if (task === 'tts') return pass(await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(str(b.voiceId, 64))}?output_format=mp3_44100_128`, {
        method: 'POST', headers: { 'xi-api-key': EL_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ text: str(b.text, 400), model_id: 'eleven_multilingual_v2' }),
      }));
    return await cards(PROMPTS[task](b, str(b.target, 40), str(b.native, 40)));
  } catch (e) {
    console.error(e);
    return fail(500, e instanceof Error ? e.message : String(e));
  }
});
