
# X-Outpost

**X-Outpost** is a Node.js application that interacts with Twitter's API to collect tweets, generate responses using a language model, and post replies. It utilizes MongoDB for data storage and PM2 for process management.

## Running the system
```
pm2 start ecosystem.config.js
```

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

# System Architecture

This project consists of several interconnected scripts that work together to create a Twitter/X bot capable of monitoring tweets, generating contextually relevant responses, and posting them. Here's how they fit together:

## System Components

### 1. Data Collection (`scraper.mjs`)
- **Purpose**: Fetches tweets from Twitter API and stores them in MongoDB
- **Key Functions**:
  - Monitors home timeline and mentions
  - Stores tweets, authors, and media in MongoDB
  - Handles rate limiting with adaptive rate limiter
  - Processes media attachments
  - Filters out unwanted content (spam, crypto pumps)

### 2. Context Building (`llm_response_context.mjs`)
- **Purpose**: Analyzes tweets and builds rich context for response generation
- **Key Functions**:
  - Prioritizes tweets based on engagement metrics
  - Builds conversation context from tweet threads
  - Processes images using vision API
  - Creates detailed prompts for the LLM
  - Marks tweets as ready for response generation

### 3. Author Analysis (`author_notes.mjs`)
- **Purpose**: Builds evolving profiles of tweet authors
- **Key Functions**:
  - Analyzes an author's tweet history
  - Generates personality insights and communication style notes
  - Updates author profiles when significant new data is available
  - Helps personalize responses based on author characteristics

### 4. Response Generation (`generate_responses.mjs`)
- **Purpose**: Creates AI-generated responses to tweets
- **Key Functions**:
  - Retrieves tweets that have context but no response
  - Uses OpenAI API to generate appropriate responses
  - Summarizes recent tweets from authors
  - Updates the database with generated responses
  - Runs in a continuous loop, checking for new tweets to respond to

### 5. Response Posting (`xresponder.mjs`)
- **Purpose**: Posts generated responses to Twitter/X
- **Key Functions**:
  - Fetches responses that haven't been posted yet
  - Posts responses with reference to original tweets
  - Implements rate limiting and retry logic
  - Marks responses as posted in the database

## Data Flow

The system works as a pipeline:

1. **Collection**: scraper.mjs collects tweets and stores them in MongoDB
2. **Context**: llm_response_context.mjs identifies tweets to respond to and builds context
3. **Analysis**: author_notes.mjs maintains profiles of tweet authors
4. **Generation**: generate_responses.mjs creates responses using the context
5. **Publishing**: xresponder.mjs posts the responses to Twitter

## MongoDB Collections

The scripts share these key collections:
- `tweets`: Raw tweet data
- `authors`: Information about tweet authors
- `responses`: Generated responses and their status
- `following`: List of accounts being followed
- `image_visions`: Cached image descriptions

## Execution Model

Each script runs independently, typically using:
- Continuous loops with timed delays
- Cron scheduling (in llm_response_context.mjs)
- Error handling with retry mechanisms
- Rate limiting to respect API constraints

   