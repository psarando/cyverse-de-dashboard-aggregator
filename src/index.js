import express from "express";
import { Client } from "pg";

import { getPublicAppIDs } from "./clients/permissions";
import { getFilteredTargetIds } from "./clients/metadata";

import * as config from "./configuration";
import logger, { errorLogger, requestLogger } from "./logging";
import recentlyAddedHandler, {
    getData as recentlyAddedData,
} from "./apps/recentlyAdded";
import publicAppsHandler, { getData as publicAppsData } from "./apps/public";
import recentlyUsedHandler, { getRecentlyUsedApps } from "./apps/recentlyUsed";
import recentAnalysesHandler, {
    getData as recentAnalysesData,
} from "./analyses/recent";
import runningAnalysesHandler, {
    getData as runningAnalysesData,
} from "./analyses/running";
import popularFeaturedHandler, {
    getData as popularFeaturedData,
} from "./apps/popularFeatured";
import { validateInterval, validateLimit } from "./util";

import WebsiteFeed, {
    feedURL,
    VideoFeed,
    DashboardInstantLaunchesFeed,
} from "./feed";
import constants from "./constants";

import opentelemetry from "@opentelemetry/api";

function tracer() {
    return opentelemetry.trace.getTracer("dashboard-aggregator");
}

logger.info("creating database client");

// Set up the database connection. May have to change to a Pool in the near future.
const db = new Client({
    host: config.dbHost,
    user: config.dbUser,
    password: config.dbPass,
    database: config.dbDatabase,
    port: config.dbPort,
});

db.connect();

// Populate feeds from the website.
const newsFeed = new WebsiteFeed(
    feedURL(config.websiteURL, config.newsFeedPath)
);
newsFeed.pullItems(); // populate the local copy.
newsFeed.scheduleRefresh().then((f) => f.start()); // schedule the refresh of the local copy.

const eventsFeed = new WebsiteFeed(
    feedURL(config.websiteURL, config.eventsFeedPath)
);
eventsFeed.pullItems();
eventsFeed.scheduleRefresh().then((f) => f.start());

const videosFeed = new VideoFeed(config.videosURL);
videosFeed.pullItems();
videosFeed.scheduleRefresh().then((f) => f.start());

const ilFeed = new DashboardInstantLaunchesFeed(config.appExposerURL);
// ilFeed.pullItems();
// ilFeed.scheduleRefresh().start();

logger.info("setting up the express server");
const app = express();

app.use(errorLogger);
app.use(requestLogger);

const createFeeds = async (limit) => {
    return tracer().startActiveSpan("createFeeds", async (span) => {
        try {
            const newsItems = await newsFeed.getItems();
            const eventsItems = await eventsFeed.getItems();
            const videosItems = await videosFeed.getItems();

            return {
                news: newsItems.slice(0, limit),
                events: eventsItems.slice(0, limit),
                videos: videosItems.slice(0, limit),
            };
        } finally {
            span.end();
        }
    });
};

/**
 * Health check handler. Should be used by liveness and readiness checks.
 */
app.get("/healthz", async (req, res) => {
    const { rows } = await db
        .query("select version from version order by applied desc limit 1")
        .catch((e) => logger.error(e));

    if (!rows) {
        res.status(500).send("no rows returned from database");
        return;
    }

    res.status(200).send(`version ${rows[0].version}`);
});

app.get("/users/:username/apps/public", publicAppsHandler(db));
app.get("/users/:username/apps/recently-added", recentlyAddedHandler(db));
app.get("/users/:username/apps/recently-used", recentlyUsedHandler(db));
app.get("/users/:username/analyses/recent", recentAnalysesHandler());
app.get("/users/:username/analyses/running", runningAnalysesHandler());
app.get("/users/:username/apps/popular-featured", popularFeaturedHandler(db));
app.get("/users/:username", async (req, res) => {
    try {
        const username = req.params.username;
        const startDateInterval =
            (await validateInterval(req?.query["start-date-interval"])) ??
            constants.DEFAULT_START_DATE_INTERVAL;
        const limit = validateLimit(req?.query?.limit) ?? 10;

        const instantLaunches = ilFeed.getItems();
        const feeds = createFeeds(limit);

        // Analyses data
        const recentAnalyses = recentAnalysesData(username, limit);
        const runningAnalyses = runningAnalysesData(username, limit);

        // Apps data
        const publicAppIDs = getPublicAppIDs();

        const recentlyAdded = recentlyAddedData(
            db,
            username,
            limit,
            await publicAppIDs
        );
        const publicApps = publicAppsData(
            db,
            username,
            limit,
            await publicAppIDs
        );
        const recentlyUsed = getRecentlyUsedApps(
            db,
            username,
            limit,
            startDateInterval,
            await publicAppIDs
        );

        const featuredAppIds = getFilteredTargetIds({
            targetTypes: ["app"],
            targetIds: await publicAppIDs,
            avus: constants.FEATURED_APPS_AVUS,
            username,
        });
        const popularFeatured = popularFeaturedData(
            db,
            username,
            limit,
            await featuredAppIds,
            startDateInterval
        );

        const retval = {
            apps: {
                recentlyAdded: await recentlyAdded,
                public: await publicApps,
                recentlyUsed: await recentlyUsed,
                popularFeatured: await popularFeatured,
            },
            analyses: {
                recent: (await recentAnalyses)?.analyses,
                running: (await runningAnalyses)?.analyses,
            },
            instantLaunches: await instantLaunches,
            feeds: await feeds,
        };

        res.status(200).json(retval);
    } catch (e) {
        logger.error(e);
        res.status(500).json({ reason: `error running query: ${e}` });
    }
});

app.get("/", async (req, res) => {
    try {
        const limit = validateLimit(req?.query?.limit) ?? 10;
        const username = "anonymous";
        const startDateInterval =
            (await validateInterval(req?.query["start-date-interval"])) ??
            constants.DEFAULT_START_DATE_INTERVAL;
        const feeds = await createFeeds(limit);
        const publicAppIDs = getPublicAppIDs();
        const featuredAppIds = getFilteredTargetIds({
            targetTypes: ["app"],
            targetIds: await publicAppIDs,
            avus: constants.FEATURED_APPS_AVUS,
            username,
        });
        const retval = {
            apps: {
                popularFeatured: await popularFeaturedData(
                    db,
                    username,
                    limit,
                    await featuredAppIds,
                    startDateInterval
                ),
            },
            feeds: await feeds,
        };
        res.status(200).json(retval);
    } catch (e) {
        logger.error(e);
        res.status(500).json({ reason: `error running query: ${e.message}` });
    }
});

app.get("/feeds", async (req, res) => {
    try {
        const limit = validateLimit(req?.query?.limit) ?? 10;
        const feeds = await createFeeds(limit);

        res.status(200).json({
            feeds,
        });
    } catch (e) {
        logger.error(e);
        res.status(500).json({ reason: `error getting feeds: ${e.message}` });
    }
});

app.get("/apps/public", publicAppsHandler(db));
app.get("/apps/recently-ran", recentlyUsedHandler(db));

/**
 * Start up the server on the configured port.
 */
app.listen(config.listenPort, (err) => {
    if (err) throw err;
    logger.info(`> Ready on http://localhost:${config.listenPort}`);
});
