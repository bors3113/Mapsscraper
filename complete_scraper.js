const puppeteer = require('puppeteer');
const { Cluster } = require('puppeteer-cluster');
const fs = require('fs');
const readline = require('readline');
const express = require('express');
const cors = require('cors');
const app = express();
const path = require('path');
const XLSX = require('xlsx');

// Add middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname))); // Serve static files from current directory

// Add this route before your API endpoint
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Create readline interface for user input
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Promisify the question function
const question = (query) => new Promise((resolve) => rl.question(query, resolve));

// Function to format search query
function formatSearchQuery(query) {
  return query.trim().replace(/\s+/g, '+');
}

// Step 1: Scrape Google Maps data
async function scrapeInitialData(searchQuery) {
  console.log('Starting initial scraping...');
  
  const browser = await puppeteer.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  const formattedQuery = formatSearchQuery(searchQuery);
  const searchUrl = `https://www.google.com/maps/search/${formattedQuery}/`;
  console.log(`Searching: ${searchUrl}`);

  await page.goto(searchUrl, {
    waitUntil: 'networkidle2',
    timeout: 60000
  });

  const scrapedData = await page.evaluate(async () => {
    const targetDiv = document.querySelector('[role="feed"]');
    const results = [];
    const observedNames = new Set();

    if (!targetDiv) {
      throw new Error('Feed not found!');
    }

    let previousCount = 0;
    let unchangedScrolls = 0;
    const maxUnchangedScrolls = 5;
    const scrollInterval = 2000;
    const scrollStep = 500;

    while (unchangedScrolls < maxUnchangedScrolls) {
      targetDiv.scrollBy(0, scrollStep);
      await new Promise((resolve) => setTimeout(resolve, scrollInterval));

      const elements = document.querySelectorAll('a.hfpxzc');
      elements.forEach(element => {
        const name = element.getAttribute('aria-label');
        const link = element.getAttribute('href');

        if (name && link && !observedNames.has(name)) {
          observedNames.add(name);
          results.push({ name, link });
        }
      });

      if (results.length === previousCount) {
        unchangedScrolls++;
      } else {
        unchangedScrolls = 0;
        previousCount = results.length;
      }
    }

    return results;
  });

  await browser.close();
  return scrapedData;
}

// Extract Maps details
async function scrapeGoogleMapsData(page) {
  try {
    const address = await page.evaluate(() => {
      const addressElement = document.querySelector('div.rogA2c div.Io6YTe.fontBodyMedium:not(.ITvuef)');
      return addressElement ? addressElement.textContent.trim() : "N/A";
    });

    const website = await page.evaluate(() => {
      const websiteElement = document.querySelector('div.rogA2c.ITvuef div.Io6YTe.fontBodyMedium');
      return websiteElement ? websiteElement.textContent.trim() : "N/A";
    });

    const phone = await page.evaluate(() => {
      const elements = document.querySelectorAll('div.rogA2c div.Io6YTe.fontBodyMedium');
      for (const element of elements) {
        const text = element.textContent.trim();
        if (text.includes('+')) {
          return text;
        }
      }
      return "N/A";
    });

    return { address, website, phone };
  } catch (error) {
    console.error("Error scraping Maps data:", error);
    return { address: "N/A", website: "N/A", phone: "N/A" };
  }
}

// Extract website contact info
async function extractContactInfo(page) {
  return await page.evaluate(() => {
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z0-9-]{2,})/gi;
    
    const socialMediaPatterns = {
      facebook: /(?:https?:\/\/)?(?:www\.)?facebook\.com\/[^/\s"']+/gi,
      instagram: /(?:https?:\/\/)?(?:www\.)?instagram\.com\/[^/\s"']+/gi,
      twitter: /(?:https?:\/\/)?(?:www\.)?twitter\.com\/[^/\s"']+/gi,
      linkedin: /(?:https?:\/\/)?(?:www\.)?linkedin\.com\/(?:company|in)\/[^/\s"']+/gi
    };

    const pageContent = document.body.innerHTML;
    const emails = [...new Set(pageContent.match(emailRegex) || [])];
    const socialMedia = {};
    
    for (const [platform, regex] of Object.entries(socialMediaPatterns)) {
      socialMedia[platform] = [...new Set(pageContent.match(regex) || [])];
    }

    return { emails, socialMedia };
  });
}

// Main function to run both steps
async function runCompleteScrape() {
  try {
    // Get user input
    console.log('\nWhat would you like to search for? (e.g., "dentist chicago" or "restaurants paris")');
    const searchQuery = await question('Enter search query: ');
    
    if (!searchQuery.trim()) {
      console.error('Search query cannot be empty');
      process.exit(1);
    }

    const formattedQuery = formatSearchQuery(searchQuery);
    console.log(`\nFormatted search query: ${formattedQuery}`);
    console.log(`Full URL: https://www.google.com/maps/search/${formattedQuery}/`);
    
    const confirm = await question('\nIs this correct? (y/n): ');
    if (!confirm.toLowerCase().startsWith('y')) {
      console.log('Search cancelled. Please try again.');
      process.exit(0);
    }

    // Step 1: Get initial Maps data
    console.log('\nStep 1: Scraping initial data...');
    const mapsData = await scrapeInitialData(searchQuery);
    console.log(`Found ${mapsData.length} results`);

    // Save Maps data with search query info
    const initialJsonData = {
      searchQuery: searchQuery,
      formattedQuery: formattedQuery,
      totalCount: mapsData.length,
      scrapedAt: new Date().toISOString(),
      results: mapsData
    };
    
    const outputFileName = `${formattedQuery}_initial.json`;
    fs.writeFileSync(outputFileName, JSON.stringify(initialJsonData, null, 2));
    console.log(`Initial data saved to ${outputFileName}`);

    // Step 2: Process each dentist with cluster
    console.log('\nStep 2: Processing detailed data using cluster...');
    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_PAGE,
      maxConcurrency: 3,
      puppeteerOptions: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--window-size=1920,1080',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu'
        ],
        defaultViewport: null
      },
      timeout: 60000,
      monitor: true,
      retryLimit: 2,
      retryDelay: 5000
    });

    const detailedData = [];

    // Define cluster task
    await cluster.task(async ({ page, data: dentist }) => {
      try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });

        // Get Maps details
        console.log(`Processing Maps details for: ${dentist.name}`);
        await page.goto(dentist.link, { 
          waitUntil: 'networkidle2',
          timeout: 60000 
        });

        await new Promise(resolve => setTimeout(resolve, 2000));
        const mapsDetails = await scrapeGoogleMapsData(page);

        // Get website data if available
        let websiteData = { emails: [], socialMedia: {} };
        if (mapsDetails.website && mapsDetails.website !== 'N/A') {
          console.log(`Processing website for: ${dentist.name}`);
          const websiteUrl = mapsDetails.website.startsWith('http') 
            ? mapsDetails.website 
            : `https://${mapsDetails.website}`;

          try {
            await page.goto(websiteUrl, { 
              waitUntil: 'networkidle2',
              timeout: 30000 
            });
            websiteData = await extractContactInfo(page);
          } catch (websiteError) {
            console.error(`Error processing website for ${dentist.name}:`, websiteError.message);
          }
        }

        const result = {
          name: dentist.name,
          mapsLink: dentist.link,
          ...mapsDetails,
          websiteData: websiteData,
          scrapedAt: new Date().toISOString()
        };

        detailedData.push(result);
        console.log(`Completed processing: ${dentist.name}`);
        return result;

      } catch (error) {
        console.error(`Error processing ${dentist.name}:`, error.message);
        const errorResult = {
          name: dentist.name,
          mapsLink: dentist.link,
          error: error.message,
          scrapedAt: new Date().toISOString()
        };
        detailedData.push(errorResult);
        return errorResult;
      }
    });

    // Queue all dentists
    for (const dentist of mapsData) {
      await cluster.queue(dentist);
    }

    // Wait for completion
    await cluster.idle();
    await cluster.close();

    // Save final data with search query info
    const finalData = {
      searchQuery: searchQuery,
      formattedQuery: formattedQuery,
      totalCount: detailedData.length,
      scrapedAt: new Date().toISOString(),
      results: detailedData
    };

    const finalOutputFileName = `${formattedQuery}_final.json`;
    fs.writeFileSync(finalOutputFileName, JSON.stringify(finalData, null, 2));
    console.log(`\nComplete data saved for ${detailedData.length} results in ${finalOutputFileName}`);

  } catch (error) {
    console.error('Error during scraping:', error);
    process.exit(1);
  } finally {
    rl.close();
  }
}

// Add this API endpoint before runCompleteScrape()
app.post('/api/scrape', async (req, res) => {
  try {
    const { searchQuery } = req.body;
    if (!searchQuery) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    // Get initial Maps data
    console.log('\nStep 1: Scraping initial data...');
    const mapsData = await scrapeInitialData(searchQuery);
    
    // Process detailed data using cluster
    console.log('\nStep 2: Processing detailed data using cluster...');
    const cluster = await Cluster.launch({
      concurrency: Cluster.CONCURRENCY_PAGE,
      maxConcurrency: 3,
      puppeteerOptions: {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--window-size=1920,1080',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu'
        ],
        defaultViewport: null
      },
      timeout: 60000,
      monitor: true,
      retryLimit: 2,
      retryDelay: 5000
    });

    const detailedData = [];

    // Define cluster task
    await cluster.task(async ({ page, data: business }) => {
      try {
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });

        await page.goto(business.link, { 
          waitUntil: 'networkidle2',
          timeout: 60000 
        });

        await new Promise(resolve => setTimeout(resolve, 2000));
        const mapsDetails = await scrapeGoogleMapsData(page);

        let websiteData = { emails: [], socialMedia: {} };
        if (mapsDetails.website && mapsDetails.website !== 'N/A') {
          try {
            const websiteUrl = mapsDetails.website.startsWith('http') 
              ? mapsDetails.website 
              : `https://${mapsDetails.website}`;

            await page.goto(websiteUrl, { 
              waitUntil: 'networkidle2',
              timeout: 30000 
            });
            websiteData = await extractContactInfo(page);
          } catch (websiteError) {
            console.error(`Error processing website for ${business.name}:`, websiteError.message);
          }
        }

        const result = {
          name: business.name,
          mapsLink: business.link,
          ...mapsDetails,
          websiteData: websiteData
        };

        detailedData.push(result);
        return result;

      } catch (error) {
        console.error(`Error processing ${business.name}:`, error.message);
        return {
          name: business.name,
          mapsLink: business.link,
          error: error.message
        };
      }
    });

    // Queue all businesses
    for (const business of mapsData) {
      await cluster.queue(business);
    }

    // Wait for completion
    await cluster.idle();
    await cluster.close();

    res.json({
      searchQuery,
      totalCount: detailedData.length,
      results: detailedData
    });

  } catch (error) {
    console.error('Error during scraping:', error);
    res.status(500).json({ error: error.message });
  }
});
//hnaaaa dit l code
// Single, correct file listing endpoint
app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(__dirname)
      .filter(file => file.endsWith('_final.json'))
      .map(file => {
        const filePath = path.join(__dirname, file);
        const stats = fs.statSync(filePath);
        return {
          name: file,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      });
    
    res.json({ files });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Single, correct file download endpoint
app.get('/api/files/:filename', (req, res) => {
  try {
    const filePath = path.join(__dirname, req.params.filename);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.download(filePath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Improved file saving function
function saveQueryResults(formattedQuery, finalData) {
  try {
    const finalOutputFileName = path.join(__dirname, `${formattedQuery}_final.json`);
    fs.writeFileSync(finalOutputFileName, JSON.stringify(finalData, null, 2));
    console.log(`\nComplete data saved in ${finalOutputFileName}`);
    return path.basename(finalOutputFileName);
  } catch (error) {
    console.error('Error saving file:', error);
    throw error;
  }
}

// Run the complete scraper
runCompleteScrape()
  .then(() => console.log('Complete scraping process finished successfully!'))
  .catch(console.error);

// Add this at the bottom of the file
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});