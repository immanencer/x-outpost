import process from 'process';
import dotenv from 'dotenv';
dotenv.config();

const { OPENROUTER_API_URL, OPENROUTER_API_KEY, VISION_MODEL } = process.env;

import OpenAI from "openai";

const openai = new OpenAI({
    baseURL: OPENROUTER_API_URL,
    apiKey: OPENROUTER_API_KEY,
    defaultHeaders: {
        "HTTP-Referer": "https://theerebusai.com", // Replace with your site URL (optional)
        "X-Title": "Erebus" // Replace with your app name (optional)
    }
});

export async function describeImage(fileUrl) {
    try {
        const response = await openai.chat.completions.create({
            model: VISION_MODEL,
            messages: [
                {
                    role: "user",
                    content: [
                        {
                            type: "text",
                            text: "Describe the contents of the image in detail."
                        },
                        {
                            type: "image_url",
                            image_url: {
                                url: fileUrl
                            }
                        }
                    ]
                }
            ]
        });

        if (!response.choices || !response.choices[0]) {
            return 'No description available.';
        }

        return response.choices[0]?.message?.content || 'No description available.';
    } catch (error) {
        console.error("Error describing image:", error);
        throw new Error("Failed to describe image. Please try again.");
    }
}
