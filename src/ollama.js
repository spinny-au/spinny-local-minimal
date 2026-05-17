export class OllamaClient {
  constructor(baseUrl = process.env.SPINNY_OLLAMA_URL || "http://127.0.0.1:11434") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async pullModel(model) {
    if (!/^[a-zA-Z0-9._:/-]+$/.test(model)) {
      throw new Error("Invalid Ollama model name");
    }
    const response = await fetch(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model, stream: false })
    });
    if (!response.ok) {
      throw new Error(`Ollama pull failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

  async *pullModelStream(model) {
    if (!/^[a-zA-Z0-9._:/-]+$/.test(model)) {
      throw new Error("Invalid Ollama model name");
    }
    const response = await fetch(`${this.baseUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model, stream: true })
    });
    if (!response.ok || !response.body) {
      throw new Error(`Ollama pull failed: ${response.status} ${await response.text()}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) yield JSON.parse(line);
        newline = buffer.indexOf("\n");
      }
    }
    if (buffer.trim()) yield JSON.parse(buffer.trim());
  }

  async generate({ model, prompt, context = "" }) {
    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt: context ? `${context}\n\n${prompt}` : prompt,
        stream: false
      })
    });
    if (!response.ok) {
      throw new Error(`Ollama generate failed: ${response.status} ${await response.text()}`);
    }
    return response.json();
  }

  async health() {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return { ok: response.ok, status: response.status };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }
}
