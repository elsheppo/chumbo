:root {
  color-scheme: light dark;
  font-family: var(
    --chumbo-font-family,
    var(--font-sans, ui-sans-serif, system-ui, sans-serif)
  );
  background: transparent;
  color: var(--chumbo-text, var(--color-text-primary, #17211b));
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  background: transparent;
}

button {
  font: inherit;
}

.shell {
  width: min(100%, 760px);
  margin: 0 auto;
}

.header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 16px;
}

.eyebrow {
  margin: 0 0 4px;
  color: var(--chumbo-text-secondary, var(--color-text-secondary, #5d6a63));
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
}

h1,
h2,
p {
  margin-top: 0;
}

h1 {
  margin-bottom: 0;
  font-size: clamp(22px, 4.5vw, 30px);
  line-height: 1.1;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.action-button {
  padding: 7px 13px;
  border: 1px solid var(--chumbo-border, var(--color-border-primary, #cfd8d2));
  border-radius: 999px;
  background: var(--chumbo-surface, var(--color-background-primary, #ffffff));
  color: inherit;
  cursor: pointer;
  font-size: 13px;
  font-weight: 600;
}

.action-button:focus-visible {
  outline: 3px solid
    color-mix(in srgb, var(--chumbo-brand-accent, #2f7a4d) 35%, transparent);
  outline-offset: 2px;
}

.action-button:disabled {
  cursor: wait;
  opacity: 0.55;
}

.notice {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid #e9b9b0;
  border-radius: 10px;
  background: color-mix(in srgb, #d85b45 8%, transparent);
  font-size: 13px;
}

.notice[data-tone="success"] {
  border-color: #a9d4b8;
  background: color-mix(in srgb, #2f9b5b 9%, transparent);
}

.content {
  display: grid;
  align-content: start;
  gap: 10px;
}

.card,
.empty {
  padding: 14px 16px;
  border: 1px solid var(--chumbo-border, var(--color-border-primary, #d8ded9));
  border-radius: 12px;
  background: var(--chumbo-surface, var(--color-background-primary, #ffffff));
}

.empty {
  margin-bottom: 0;
  color: var(--chumbo-text-secondary, var(--color-text-secondary, #5d6a63));
  text-align: center;
}

@media (max-width: 520px) {
  .shell {
    --supa-mcp-app-padding-block: 14px;
    --supa-mcp-app-padding-inline: 14px;
  }
}
