import { promises as fsPromises } from 'fs';
import { join as joinPath } from 'path';
import { hostname } from 'os';
import { createServer } from 'http';

import nconf from 'nconf';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

import { parse as parseToml } from 'toml';

const { readFile, readdir: readDir } = fsPromises;

const CONF_CONFIG_FILE = 'traefik-config-file';
const CONF_PORT = 'port';

async function setupOptions ()
{
    const PACKAGE_JSON = JSON.parse(
        await readFile(new URL('./package.json', import.meta.url), 'utf-8'),
    );

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

    const traefikConfig = parseToml(await readFile(traefikConfigFilePath, 'utf-8'));

    const routers =
        (traefikConfig.http || {}).routers || [];

    const providersDirectory =
        ((traefikConfig.providers || {}).file || {}).directory;

    if (providersDirectory)
    {
        const providersConfigPromise =
            (await readDir(providersDirectory))
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
        .map(({ service, rule }) => [
            service,
            rule.match(/^PathPrefix\(.(.*).\)$/)[1],
        ]);
    const routes = new Map(routesEntries);

    process.stdout.write(`Found ${routes.size} route(s)\n`);

    return routes;
}

function createRequestHandler (routes)
{
    const title = hostname();
    const html = [
        '<!doctype html>',
        '<html>',
        `<title>${title}</title>`,
        '<style>:root { font: 3em/1 sans-serif; }</style>',
        `<h1>${title}</h1>`,
        '<ul>',
        ...Array.from(routes.entries()).map(
            ([name, url]) => `<li><a href="${url}">${name}</a>`,
        ),
    ].join('');

    return function requestHandler (request, response) {
        process.stdout.write(`${request.method} ${request.url}\n`);

        if (request.url === '/favicon.ico')
        {
            response.writeHead(404);
            response.end();
            return;
        }

        response.writeHead(200, 'Found', {
            'Content-Type': 'text/html',
        });
        response.end(html);
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

async function createIndexServer (port, routes)
{
    const server = createServer(createRequestHandler(routes));
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

    const routes = await getRoutes(traefikConfigFilePath);
    createIndexServer(port, routes);
}

main();
