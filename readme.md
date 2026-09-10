# Enterprise AI Assistant

An AI assistant designed to help enterprises automate tasks, access information, and improve productivity.

## Features
- AI-powered assistance
- MVP

## Structure

```
enterprise-ai-assistant/
  apps/
    web/          # React frontend (Vite)
    api/          # Node.js/Express backend, calls the OpenAI API
  packages/
    shared/       # shared types/contracts (used later, e.g. by a RAG/agent layer)
  docs/
```

## Getting started

1. Install dependencies from the repo root:
   ```
   npm install
   ```
2. Configure the backend: copy `apps/api/.env.example` to `apps/api/.env` and set `OPENAI_API_KEY`.
3. Run the backend and frontend in separate terminals:
   ```
   npm run dev:api
   npm run dev:web
   ```
4. Open http://localhost:5173
