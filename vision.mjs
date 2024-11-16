import process from 'process';
const { OPENAI_API_KEY, OPENAI_API_URI, VISION_MODEL } = process.env;

if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is required');
}
if (!OPENAI_API_URI) {
    throw new Error('OPENAI_API_URI is required');
}
if(!VISION_MODEL){
    throw new Error('VISION_MODEL is required');
}

import OpenAI from "openai";
const openai = new OpenAI({
    apiKey: OPENAI_API_KEY,
    baseURL: OPENAI_API_URI
});

export async function describeImage(fileUrl) {
    // Get description from vision model
    const response = await openai.chat.completions.create({
        model: VISION_MODEL,
        messages: [
            { role: "system", content: "You are a helpful AI." },
            {
                role: "user",
                content: [
                    { type: "text", text: "Describe the contents of the image in detail" },
                    { type: "image_url", url: fileUrl }
                ],
            },
        ],
        max_tokens: 128,
    });

    return response;
}