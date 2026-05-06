'use strict';

const { getDb } = require('../db/database');
const { v4: uuidv4 } = require('uuid');

/**
 * Async-fire-and-forget training data logger.
 * Never throws — silently swallows errors so it never affects the main request.
 *
 * source: 'chat' | 'coach' | 'demo'
 * quality: 0=unrated, 1=good (widget created/lead captured), -1=bad (error)
 */
function logTrainingSample({ source, systemPrompt, userInput, assistantOutput, toolCalls, widgetId, quality = 0 }) {
  setImmediate(() => {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO ai_training_samples (id, source, system_prompt, user_input, assistant_output, tool_calls, widget_id, quality)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        source,
        systemPrompt ? String(systemPrompt).slice(0, 8000) : null,
        String(userInput).slice(0, 4000),
        String(assistantOutput).slice(0, 8000),
        toolCalls ? JSON.stringify(toolCalls) : null,
        widgetId || null,
        quality,
      );
    } catch (_) { /* never block the main request */ }
  });
}

module.exports = { logTrainingSample };
