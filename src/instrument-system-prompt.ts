/**
 * Build the pitched-instrument composition system prompt for the LLM.
 *
 * Different from the drum-pattern prompt in three ways:
 *   1. Output is melodic/harmonic. Pitch carries the music. The LLM is
 *      expected to emit pitched notes across the playable MIDI range
 *      (usually C2-C6 / 36-84) rather than flattening to 60.
 *   2. The sampler is multi-zone polyphonic (host.setTrackInstrumentSampler).
 *      Multiple simultaneous notes layer into chords correctly; chords,
 *      arpeggios, dyads, polyphonic textures are all in scope.
 *   3. Category vocabulary is dynamic — discovered from the filesystem at
 *      plugin activate time (subdirectories of <root>/instruments/). The
 *      plugin enumerates the categories that have at least one instrument
 *      and passes them in. Empty libraries (zero categories) should never
 *      reach this builder; the panel should refuse to generate in that
 *      case rather than asking the LLM to pick from an empty list.
 *
 * Response is a JSON object the panel parses. The `category` field tells
 * the panel which folder to pick a random instrument from after the MIDI
 * is generated (mirrors the drum plugin's role+subRole pick).
 */
export function buildInstrumentSystemPrompt(availableCategories: readonly string[]): string {
  if (availableCategories.length === 0) {
    // Programmer error — the panel should have refused to call us.
    // Bake a defensive fallback so the LLM at least produces parseable
    // output; the panel will surface "no library" before this matters.
    return `You are a melodic composition AI. The instrument library is empty — respond with: {"notes":[],"category":""}`;
  }

  const categoryList = availableCategories.join(', ');
  return `You are a melodic composition AI. Given a musical context and a text description, generate a pitched, polyphonic MIDI clip for a sample-based instrument.

Respond with ONLY a JSON object in this format:
{
  "notes": [
    { "pitch": 60, "startBeat": 0, "durationBeats": 1.0, "velocity": 96 }
  ],
  "category": "plucks",
  "sound": "warm vintage valve mellow"
}

Rules:
- pitch: a MIDI note number 21-108 (A0 to C8). Vary pitch — this is a pitched instrument, the played note IS the audible pitch. The sampler pitch-shifts a stored sample to the played note, so notes around C3-C5 (48-72) sound most natural; extremes get noticeable artifacts.
- startBeat: position in quarter-note beats from start of clip (0-based). Sub-beat values are honoured (e.g. 0.5 = eighth note).
- durationBeats: how long the note is held in quarter-note beats. The sampler is open-ended (\`openEnded=false\` for plucks/mallets/percussion; \`openEnded=true\` for sustaining categories), so for "open" instruments the note plays through to end-of-sample regardless of durationBeats — but durationBeats still controls envelope release for sustaining ones.
- velocity: 1-127. Use velocity to shape phrasing — accents, dynamics, ghost notes. Avoid constant velocity across a whole phrase.
- Polyphony: multiple simultaneous notes are fine and encouraged for chords, dyads, two-handed textures. The sampler voice-allocates per-note.
- category: MUST be one of: ${categoryList}. Pick the single best fit for the user's request. If the user names a specific category (e.g. "warm pad") use that; otherwise infer from instrument cues ("guitar", "synth", "bass").
- sound: a SHORT phrase (3-8 words) describing the desired TIMBRE / CHARACTER of the instrument. The plugin matches it against a library of per-instrument text descriptions to pick the closest-sounding one. Translate era / genre / mood cues into concrete sonic words: "1950s" → "vintage warm valve mellow", "ambient" → "lush airy evolving pad", "aggressive lead" → "bright cutting detuned saw". Describe tone / material / era / character only — NOT which notes to play. Omit the field only when the request implies no particular timbre.

Style guidance:
- Match the bar count and tempo from the musical context.
- Respect any chord/contract hints in the musical context — voice notes consistent with the chord progression at each beat.
- If "Concurrent tracks in scene" are listed, compose to COMPLEMENT them: lock to the bassline's root motion, avoid clashing with notes already sounding, and leave rhythmic space rather than doubling another part.
- For monophonic instruments (basses, plucks, leads) emit one note at a time; for polyphonic (pads, keys, organs) chords are welcome.
- Keep one track focused on one role — don't switch categories mid-clip.`;
}
