// findSnakes.mjs

export class SnakeFinder {
    constructor(db) {
        this.db = db;
        this.tweetsCollection = db.collection('tweets');
        this.SNAKE_TERMS = {
            common: ["snake", "serpent", "reptile", "slither"],
            species: ["python", "cobra", "viper", "boa", "anaconda", "mamba"],
            emoji: ["🐍"],
            behavior: ["garden", "shed", "scales", "fangs", "venom", "coil"]
        };
    }

    async initialize() {
        try {
            const indexes = await this.tweetsCollection.listIndexes().toArray();
            for (const index of indexes) {
                if (index.type === 'text' && index.key.text === "text") { // Updated condition
                    await this.tweetsCollection.dropIndex(index.name);
                    console.log('Dropped existing text index:', index.name);
                }
            }
            await this.tweetsCollection.createIndex(
                { text: "text" },
                {
                    name: "tweet_text_index",
                    weights: { text: 1 },
                    default_language: "english"
                }
            );
            await this.tweetsCollection.createIndex(
                { created_at: -1 },
                { name: "created_at_index" }
            );
            console.log('Successfully created new text and created_at indexes');
        } catch (error) {
            console.error('Error managing indexes:', error);
            throw error;
        }
    }

    async findAll(options = { includeEmoji: true, includeSpecies: true }) {
        const textSearchTerms = [
            ...this.SNAKE_TERMS.common,
            ...(options.includeSpecies ? this.SNAKE_TERMS.species : [])
        ].join(" ");

        const emojiRegex = options.includeEmoji ? this.SNAKE_TERMS.emoji.join("|") : null;

        const textPipeline = [
            { $match: { $text: { $search: textSearchTerms } } },
            { $addFields: { score: { $meta: "textScore" } } }
        ];

        let pipeline = textPipeline;

        if (emojiRegex) {
            const emojiPipeline = [
                { $match: { text: { $regex: emojiRegex, $options: "i" } } },
                { $addFields: { score: 2 } }
            ];

            pipeline.push({
                $unionWith: {
                    coll: this.tweetsCollection.collectionName,
                    pipeline: emojiPipeline
                }
            });
        }

        pipeline.push(
            {
                $lookup: {
                    from: "authors",
                    localField: "author_id",
                    foreignField: "id",
                    as: "author"
                }
            },
            { $unwind: "$author" },
            {
                $sort: {
                    score: -1,
                    created_at: -1
                }
            }
        );

        try {
            const results = await this.tweetsCollection.aggregate(pipeline).toArray();
            console.log(`Found ${results.length} snake-related tweets`);
            return results;
        } catch (error) {
            console.error('Error in SnakeFinder:', error);
            throw error;
        }
    }
}