
# X-Outpost

**X-Outpost** is a Node.js application that interacts with Twitter's API to collect tweets, generate responses using a language model, and post replies. It utilizes MongoDB for data storage and PM2 for process management.

## Features

- **Scraper**: Collects tweets from specified authors and stores them in MongoDB.
- **Response Context Generator**: Prepares context for generating responses using an LLM.
- **Response Generator**: Generates responses to tweets mentioning or replying to a specific user.
- **Responder**: Posts generated responses to Twitter, handling rate limits and retries.
- **Author Notes**: Generates evolving notes about authors based on their tweet history.

## Prerequisites

- **Node.js** (version 14 or later)
- **MongoDB** instance
- **PM2** for process management
- **Twitter Developer Account** for API credentials
- **OpenAI Account** (or local Ollama server) for language model API

## Installation

1. **Clone the repository**:

   