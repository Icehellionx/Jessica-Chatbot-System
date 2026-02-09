// PATH: ./engine/local-api-handler.js
const axios = require('axios');

/**
 * The Brain of the operation. 
 * This file handles the logic of talking to your local AI backend.
 */
class LocalAI {
    constructor(baseUrl = 'http://localhost:1234/v1') {
        this.client = axios.create({
            baseURL: baseUrl,
            timeout: 10000 // If the LLM doesn't respond in 10s, it's probably stuck
        });
    }

    // This builds the "Advanced" prompt that sites like JanitorAI use
    async getChatResponse(userMessage, characterContext) {
        try {
            const payload = {
                model: "local-model",
                messages: [
                    { 
                        role: "system", 
                        content: `${characterContext}\n\nTECHNICAL INSTRUCTION: You are a VN engine. You must start every response with [Mood: X] and [BG: Y] tags.` 
                    },
                    { role: "user", content: userMessage }
                ],
                temperature: 0.8,
                max_tokens: 500
            };

            const response = await this.client.post('/chat/completions', payload);
            return response.data.choices[0].message.content;

        } catch (error) {
            console.error("API Error:", error.message);
            return "[System Error]: Make sure your LLM server (LM Studio/Ollama) is running!";
        }
    }
}

module.exports = new LocalAI();