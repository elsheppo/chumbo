<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{{APP_TITLE}}</title>
    <script id="mcp-app-presentation" type="application/json">__MCP_APP_PRESENTATION__</script>
  </head>
  <body>
    <main class="shell" aria-live="polite">
      <header class="header">
        <div>
          <p class="eyebrow" id="eyebrow">{{APP_TITLE}}</p>
          <h1 id="heading">{{APP_TITLE}}</h1>
        </div>
        <div class="header-actions">
          <button class="action-button" id="expand" type="button" hidden>
            Expand
          </button>
          <button class="action-button" id="refresh" type="button">
            Refresh
          </button>
        </div>
      </header>

      <p class="notice" id="notice" role="status" hidden></p>
      <section class="content" id="content" data-supa-mcp-scroll></section>
    </main>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
