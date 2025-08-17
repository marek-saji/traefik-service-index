#!/usr/bin/env node

import { promises as fsPromises, readFileSync } from 'fs';
import { join as joinPath } from 'path';
import { createServer } from 'http';
import { hostname } from 'os';

import nconf from 'nconf';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { parse as parseToml } from 'toml';

const { readFile, readdir: readDir } = fsPromises;

const CONF_CONFIG_FILE = 'traefik-config-file';
const CONF_PORT = 'port';
const CONF_DUMMY = 'dummy';

const PACKAGE_JSON = JSON.parse(
    readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
);

const STYLE = readFileSync(new URL('./main.css', import.meta.url), 'utf-8');
const SCRIPT = readFileSync(new URL('./main.js', import.meta.url), 'utf-8');

async function setupOptions ()
{
    nconf.argv(yargs(hideBin(process.argv))
        .version(PACKAGE_JSON.version)
        .usage(PACKAGE_JSON.description)
        .strict()
        .options({
            [CONF_PORT]: {
                alias: 'p',
                type: 'string',
                description: 'HTTP port to listen on',
            },
            [CONF_CONFIG_FILE]: {
                alias: 'c',
                type: 'string',
                description: 'Path to traefik configuration file',
            },
            [CONF_DUMMY]: {
                type: 'bool',
                description: 'Run in dummy mode without reading Traefik config',
            },
        }));

    nconf.env(); // FIXME

    nconf.defaults({
        [CONF_PORT]: 8000,
        [CONF_CONFIG_FILE]: '/etc/traefik/traefik.toml',
    });

    return nconf.get();
}

async function getRoutersConfig (traefikConfigFilePath)
{
    process.stdout.write(`Reading config from ${traefikConfigFilePath}\n`);
    let traefikConfigFileContents;
    try
    {
        traefikConfigFileContents = await readFile(traefikConfigFilePath, 'utf-8');
    }
    catch (error)
    {
        process.stdout.write(`WARNING Failed to read contents of '${traefikConfigFilePath}' - skipping:\n${error}\n`);
        return [];
    }

    let traefikConfig;
    try
    {
        traefikConfig = parseToml(traefikConfigFileContents);
    }
    catch (error)
    {
        process.stdout.write(`WARNING Failed to parse contents of '${traefikConfigFilePath}' - skipping:\n${error}\n`);
        return [];
    }

    const routers =
        (traefikConfig.http || {}).routers || [];

    const providersDirectory =
        ((traefikConfig.providers || {}).file || {}).directory;

    if (providersDirectory)
    {
        const providersConfigPromise =
            (await readDir(providersDirectory))
                .filter((f) => f.endsWith('.toml'))
                .map((f) => joinPath(providersDirectory, f))
                .map(getRoutersConfig);
        Object.assign(
            routers,
            ...(await Promise.all(providersConfigPromise)),
        );
    }

    return routers;
}

async function getRoutes (traefikConfigFilePath)
{
    const routersConfig = await getRoutersConfig(traefikConfigFilePath);
    const routesEntries = Object.values(routersConfig)
        .filter(({ rule }) => /PathPrefix/.test(rule))
        .map(
            ({ rule, service }) => [
                service,
                rule.match(/^PathPrefix\(.(.*).\)$/)[1],
            ],
        );
    const routes = new Map(routesEntries);

    process.stdout.write(`Found ${routes.size} route(s): ${Array.from(routes.values())}\n`);

    return routes;
}

async function getDiskSpace (path)
{
    const stat = await fsPromises.statfs(path);
    return {
        free: stat.bavail * stat.bsize,
        used: (stat.blocks - stat.bavail) * stat.bsize,
        total: stat.blocks * stat.bsize,
    };
}

async function getDiskSpaceVars (workfilesPath)
{
    const [rootStat, workfilesStat] = await Promise.all([
        getDiskSpace('/'),
        getDiskSpace(workfilesPath),
    ]);

    const formatterOptions = {
        notator: 'compact',
        style: 'unit',
        unitDisplay: 'short',
        maximumFractionDigits: 2,
    };
    const formatterMb = new Intl.NumberFormat(undefined, {
        unit: 'megabyte',
        ...formatterOptions,
    });
    const formatterGb = new Intl.NumberFormat(undefined, {
        unit: 'gigabyte',
        ...formatterOptions,
    });

    const ONE_MB = 1024 * 1024;
    const ONE_GB = 1024 * ONE_MB;

    function format (value)
    {
        if (value >= 2 * ONE_GB)
        {
            return formatterGb.format(value / ONE_GB);
        }

        return formatterMb.format(value / ONE_MB);
    }

    return {
        rootUsedSpaceBytes: rootStat.used,
        rootFreeSpaceHuman: format(rootStat.free),
        rootTotalSpaceBytes: rootStat.total,
        rootTotalSpaceHuman: format(rootStat.total),
        workfilesUsedSpaceBytes: workfilesStat.used,
        workfilesFreeSpaceHuman: format(workfilesStat.free),
        workfilesTotalSpaceBytes: workfilesStat.total,
        workfilesTotalSpaceHuman: format(workfilesStat.total),
    };
}

function createRequestHandler (routes, workfilesPath)
{
    const title = hostname();
    const html = [
        '<!doctype html>',
        '<html>',
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
        `<title>${title}</title>`,
        `<style>${STYLE}</style>`,
        `<h1>${title}</h1>`,
        '<nav>',
        '<ul>',
        ...Array.from(routes.entries()).map(([name, url]) => [
            `<li><a href="${url}" data-service>`,
            `<img src="${url}/icon.png" alt="">`,
            '<b>',
            name.substring(0, 1),
            '</b>',
            name.substring(1),
            '</a></li>',
        ].join('')),
        '</ul>',
        '</nav>',
        '<section>',
        '<dl class="df">',
        '<div class="df__item">',
        '<dt class="df__path">/</dt>',
        '<dd class="df__space">',
        '<progress value="{{rootUsedSpaceBytes}}" max="{{rootTotalSpaceBytes}}"></progress>',
        '{{rootFreeSpaceHuman}}',
        '</dd>',
        '</div>',
        '<div class="df__item">',
        `<dt class="df__path">${workfilesPath}</dt>`,
        '<dd class="df__space">',
        '<progress value="{{workfilesUsedSpaceBytes}}" max="{{workfilesTotalSpaceBytes}}"></progress>',
        '{{workfilesFreeSpaceHuman}}',
        '</dd>',
        '</div>',
        '</dl>',
        '</section>',
        `<script type=module>${SCRIPT}</script>`,
    ].join('\n');

    return async function requestHandler (request, response) {
        process.stdout.write(`${request.method} ${request.url}\n`);

        if (request.url === '/favicon.ico')
        {
            response.writeHead(404);
            response.end();
        }
        else
        {
            const variables = {
                ...await getDiskSpaceVars(workfilesPath),
            };
            response.writeHead(200, 'Found', {
                'Content-Type': 'text/html',
            });
            let responseHtml = html;
            for (const [key, value] of Object.entries(variables))
            {
                responseHtml = responseHtml.replace(new RegExp(`{{${key}}}`, 'g'), value);
            }
            response.end(responseHtml);
        }
    };
}

function formatHttpAddress ({ family, address: rawAddress, port })
{
    let address = rawAddress;
    if (family === 'IPv6')
    {
        // FIXME if (is ip address)
        address = `[${address}]`;
    }

    return `http://${address}:${port}`;
}

async function createIndexServer (port, routes, workfilesPath)
{
    const server = createServer(
        createRequestHandler(routes, workfilesPath),
    );
    server.listen(port, () => {
        process.stdout.write(`Listening on ${formatHttpAddress(server.address())}\n`);
    });
    return server;
}

async function main ()
{
    const config = await setupOptions();

    const traefikConfigFilePath = config[CONF_CONFIG_FILE];
    const port = config[CONF_PORT];

    let routes;
    let workfilesPath;
    if (config[CONF_DUMMY])
    {
        routes = new Map([
            ['foo', '#foo'],
            ['bar', '#bar'],
        ]);
        workfilesPath = '/';
    }
    else
    {
        routes = await getRoutes(traefikConfigFilePath);
        workfilesPath = '/media/workfiles';
    }

    createIndexServer(port, routes, workfilesPath);
}

main();
