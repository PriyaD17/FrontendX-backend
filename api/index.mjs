import express from 'express';
import axios from 'axios';
import Groq from 'groq-sdk';
import cors from 'cors';
import 'dotenv/config'; 

const app = express();

const PORT = process.env.PORT || 3001;
app.use(cors()); 
app.use(express.json());

const PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY;
const PAGESPEED_ENDPOINT = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const groq = new Groq({ apiKey: GROQ_API_KEY });
// console.log(`Using PageSpeed API Key: ${PAGESPEED_API_KEY}`);

async function getPagespeedInsights(url, strategy = "desktop") {
    const params = { url, key: PAGESPEED_API_KEY, strategy };
    try {
        console.log(`Fetching PageSpeed Insights for: ${url}`);
        const resp = await axios.get(PAGESPEED_ENDPOINT, { params });
        return resp.data;
    } catch (error) {
        console.error("PageSpeed API error:", error.response?.data || error.message);
        throw new Error("Failed to fetch data from PageSpeed Insights API.");
    }
}
function extractInfoForLlm(data) {
    const lr = data.lighthouseResult || {};
    const audits = lr.audits || {};
    const info = { summary: {}, metrics: [], opportunities: [], diagnostics: {} };

    const perfScore = lr.categories?.performance?.score;
    if (perfScore !== undefined) {
        info.summary.performance_score = (perfScore * 100).toFixed(0);
    }

    const metricIds = ["largest-contentful-paint", "total-blocking-time", "cumulative-layout-shift", "first-contentful-paint", "speed-index"];
    metricIds.forEach(mid => {
        const audit = audits[mid] || {};
        if (audit.title && audit.displayValue) {
            info.metrics.push({ title: audit.title, value: audit.displayValue });
        }
    });

    for (const auditId in audits) {
        const audit = audits[auditId];
        if (audit.details?.type === 'opportunity' && audit.details?.overallSavingsMs > 0) {
            info.opportunities.push({
                title: audit.title,
                description: audit.description,
                savings: audit.displayValue || '',
            });
        }
    }

    const crcDetails = audits["critical-request-chains"]?.details || {};
    if (crcDetails.chains) {
        const longestChain = Object.values(crcDetails.chains).sort((a, b) => b.duration - a.duration)[0];
        if (longestChain) {
            info.diagnostics.critical_request_chains = `Longest chain has ${Object.keys(longestChain.children || {}).length + 1} requests and took ${longestChain.duration.toFixed(0)}ms`;
        }
    }

    const rsItems = audits["resource-summary"]?.details?.items || [];
    if (rsItems.length > 0) {
        info.diagnostics.resource_summary = rsItems.map(item =>
            `- ${item.label}: ${item.requestCount} requests, ${(item.transferSize / 1024).toFixed(0)} KB`
        ).join('\n');
    }

    return info;
}

app.get('/api', (req, res) => {
    res.send('PageSpeed Groq Analyzer API is running.');
});
app.post('/api/get-pagespeed-data', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const pagespeedData = await getPagespeedInsights(url);
        res.json(pagespeedData);
    } catch (error) {
        console.error('Error in /api/get-pagespeed-data:', error);
        res.status(500).json({ error: error.message || 'An internal server error occurred.' });
    }
});

app.post('/api/get-analysis', async (req, res) => {
    const { pagespeedData } = req.body;
    if (!pagespeedData) {
        return res.status(400).json({ error: 'pagespeedData is required' });
    }

    try {
        // 1. Extract relevant info for the LLM from the provided data
        const llmInfo = extractInfoForLlm(pagespeedData);

        // 2. Prepare the prompt for Groq
        const systemPrompt = "You are an expert web performance engineer. Your goal is to provide a clear, concise, and actionable report based on Lighthouse data. Focus on the most impactful changes a developer can make. Use markdown for formatting.";
        const userPrompt = `Please analyze the following Lighthouse audit data.
        
Provide a report with three sections:
1.  **Overall Performance Summary:** A brief, one-paragraph summary of the site's performance based on the score.
2.  **Top 3 Actionable Recommendations:** List the three most important optimizations. For each, explain *why* it's important and provide a clear, simple code example if applicable (e.g., how to preload a font,  etc.).
3.  **Key Metrics Overview:** A simple list of the core web vital metrics and their values.

Here is the data:
${JSON.stringify(llmInfo, null, 2)}`;

        // 3. Get the analysis from Groq
        const chatCompletion = await groq.chat.completions.create({
            model: "llama3-8b-8192",
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userPrompt }
            ],
            temperature: 0.4,
            max_tokens: 2048,
        });

        const analysis = chatCompletion.choices[0]?.message?.content || "Could not generate analysis.";
        
        // 4. Send the final analysis to the client
        res.json({ analysis });

    } catch (error) {
        console.error('Error in /api/get-analysis:', error);
        res.status(500).json({ error: error.message || 'An internal server error occurred.' });
    }
});


// Start the server for local development
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
}


export default app; 