import process from 'process';
const { OPENAI_API_URI, OPENAI_API_KEY } = process.env;

import OpenAI from "openai";

const openai = new OpenAI({
    baseURL: OPENAI_API_URI,
    apiKey: OPENAI_API_KEY,
    defaultHeaders: {
        "HTTP-Referer": "https://ratimics.com", // Replace with your site URL (optional)
        "X-Title": "Bob the Snake" // Replace with your app name (optional)
    }
});

export async function describeImage(fileUrl) {
    try {
        const response = await openai.chat.completions.create({
            model: "meta-llama/llama-3.2-90b-vision-instruct",
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
