import {Transform} from 'node:stream';
import {createServer} from 'node:net';
import {promisify} from 'node:util';
import chalk from 'chalk';
import {spawnd, type SpawndChildProcess, type SpawndOptions} from 'spawnd';
import cwd from 'cwd';
import waitOn, {type WaitOnOptions} from 'wait-on';
import findProcess from 'find-process';
import treeKill from 'tree-kill';
import prompts from 'prompts';

export type Config = {
	/**
	 * Command to execute to start the port.
	 * Directly passed to [`spawnd`](https://www.npmjs.com/package/spawnd).
	 * @example "npm run start"
	 * @example "yarn start"
	 * @example "node server.js"
	 * @see https://www.npmjs.com/package/spawnd#command
	 */
	command: string;
	/**
	 * Enable debug mode.
	 * @default false
	 */
	debug?: boolean;
	/**
	 * Spawnd options.
	 * @see https://www.npmjs.com/package/spawnd#options
	 */
	options?: SpawndOptions;
	/**
	 * Timeout to wait for the server to start.
	 * @default 5000
	 */
	launchTimeout?: number;
	/**
	 * Host to use to check if the port is used.
	 */
	host?: string;
	/**
	 * Port to use to check if the port is used.
	 */
	port?: number;
	/**
	 * Path to use to check if the port is used.
	 */
	path?: string;
	/**
	 * Protocol to use to check if the port is used.
	 * @default "tcp"
	 */
	protocol?: 'tcp' | 'http' | 'https' | 'socket';
	/**
	 * Action to take if the port is already used.
	 * @default "ask"
	 */
	usedPortAction?: 'ask' | 'error' | 'ignore';
	/**
	 * Options to pass to [`wait-on`](https://www.npmjs.com/package/wait-on).
	 * @see https://www.npmjs.com/package/wait-on#options
	 */
	waitOnScheme?: WaitOnOptions;
};

const resolveConfig = (config: Config): Config => ({
	debug: false,
	options: {},
	host: undefined,
	port: undefined,
	usedPortAction: 'ask',
	waitOnScheme: undefined,
	...config,
});

const pTreeKill = promisify(treeKill);

const serverLogPrefixer = new Transform({
	transform(chunk: unknown, _encoding, callback) {
		this.push(chalk.magentaBright(`[node-test-server] ${String(chunk)}`));
		callback();
	},
});

export const ERROR_TIMEOUT = 'ERROR_TIMEOUT';
export const ERROR_PORT_USED = 'ERROR_PORT_USED';
export const ERROR_NO_COMMAND = 'ERROR_NO_COMMAND';

export class NodeTestServerError extends Error {
	code?: string;
	cause?: Error;

	constructor(message: string, options?: {code?: string; cause?: Error}) {
		super(message);
		this.code = options?.code;
		this.cause = options?.cause;
	}
}

const logProcDetection = (name: string, port: number) => {
	console.log(
		chalk.blue(`🕵️  Detecting a process "${name}" running on port "${port}"`),
	);
};

const killProc = async (proc: {pid: number; name: string}) => {
	console.log(chalk.yellow(`Killing process ${proc.name}...`));
	await pTreeKill(proc.pid);
	console.log(chalk.green(`Successfully killed process ${proc.name}`));
};

const spawnServer = (config: Config) => {
	if (!config.command) {
		throw new NodeTestServerError('You must define a `command`', {
			code: ERROR_NO_COMMAND,
		});
	}

	const proc = spawnd(config.command, {
		shell: true,
		env: process.env,
		cwd: cwd(),
		...config.options,
	});

	if (config.debug) {
		console.log(chalk.magentaBright('\nJest dev-server output:'));
		proc.stdout.pipe(serverLogPrefixer).pipe(process.stdout);
	} else {
		// eslint-disable-next-line @typescript-eslint/no-empty-function
		proc.stdout.on('data', () => {});
	}

	return proc;
};

const outOfStin = async <T>(run: () => Promise<T>): Promise<T> => {
	const {stdin} = process;
	const listeners = stdin.listeners('data');
	const result = await run();
	for (const listener of listeners) {
		stdin.on('data', listener as (hadError: boolean) => void);
	}

	stdin.setRawMode(true);
	stdin.setEncoding('utf8');
	stdin.resume();
	return result;
};

const checkIsPortBusy = async (config: Config): Promise<boolean> =>
	new Promise<boolean>((resolve) => {
		const server = createServer()
			.once('error', (error: NodeJS.ErrnoException) => {
				if (error.code === 'EADDRINUSE') {
					resolve(true);
				} else {
					resolve(false);
				}
			})
			.once('listening', () => {
				server
					.once('close', () => {
						resolve(false);
					})
					.close();
			})
			.listen(config.port, config.host);
	});

type UsedPortHandler = (port: number) => boolean | Promise<boolean>;

const usedPortHandlers: Record<string, UsedPortHandler> = {
	error(port) {
		throw new NodeTestServerError(`Port ${port} is in use`, {
			code: ERROR_PORT_USED,
		});
	},
	async kill(port) {
		console.log('');
		console.log(
			`Killing process listening to ${port}. On linux, this may require you to enter your password.`,
		);
		const [portProcess] = await findProcess('port', port);

		if (!portProcess) {
			return false;
		}

		logProcDetection(portProcess.name, port);
		await killProc(portProcess);
		return true;
	},
	async ask(port) {
		console.log('');
		const answers = await outOfStin(async () =>
			prompts({
				type: 'confirm',
				name: 'kill',
				message: `Another process is listening on ${port}. Should I kill it for you? On linux, this may require you to enter your password.`,
				initial: true,
			}),
		);
		if (answers.kill) {
			const [portProcess] = await findProcess('port', port);

			if (!portProcess) {
				return false;
			}

			logProcDetection(portProcess.name, port);
			await killProc(portProcess);
			return true;
		}

		// eslint-disable-next-line unicorn/no-process-exit
		process.exit(1);
	},
	ignore(port) {
		console.log('');
		console.log(
			`Port ${port} is already used. Assuming server is already running.`,
		);
		return false;
	},
};

const handleUsedPort = async (config: Config) => {
	if (config.port === undefined) {
		return true;
	}

	if (!config.usedPortAction) {
		throw new NodeTestServerError(
			`Port ${config.port} is in use, but no action was provided to handle it. Please provide a "usedPortAction" in your config.`,
		);
	}

	const isPortBusy = await checkIsPortBusy(config);
	if (isPortBusy) {
		const usedPortHandler = usedPortHandlers[config.usedPortAction];
		return usedPortHandler?.(config.port);
	}

	return true;
};

const checkIsTimeoutError = (error: unknown): boolean => {
	if (error instanceof Error) {
		return error.message.startsWith('Timed out waiting for');
	}

	return false;
};

const waitForServerToBeReady = async (config: Config) => {
	if (config.port === undefined) {
		return;
	}

	const {
		launchTimeout = 5000,
		protocol = 'tcp',
		host,
		port,
		path,
		waitOnScheme,
	} = config;

	let resource = `${host ?? '0.0.0.0'}:${port}`;
	if (path) {
		resource = `${resource}/${path}`;
	}

	const url =
		protocol === 'tcp' || protocol === 'socket'
			? `${protocol}:${resource}`
			: `${protocol}://${resource}`;

	const options = {
		resources: [url],
		timeout: launchTimeout,
		...waitOnScheme,
	};

	try {
		await waitOn(options);
	} catch (error) {
		if (checkIsTimeoutError(error)) {
			throw new NodeTestServerError(
				`Server has taken more than ${launchTimeout}ms to start.`,
				{code: ERROR_TIMEOUT},
			);
		}

		throw error;
	}
};

const setupJestServer = async (providedConfig: Config) => {
	const config = resolveConfig(providedConfig);
	const shouldRunServer = await handleUsedPort(config);
	if (shouldRunServer) {
		const proc = spawnServer(config);
		await waitForServerToBeReady(config);
		return proc;
	}

	return null;
};

export async function setup(providedConfigs: Config | Config[]) {
	const configs = Array.isArray(providedConfigs)
		? providedConfigs
		: [providedConfigs];
	const procs = await Promise.all(
		configs.map(async (config) => setupJestServer(config)),
	);
	return procs.filter(Boolean) as SpawndChildProcess[];
}

export async function teardown(procs: SpawndChildProcess[]) {
	if (procs.length > 0) {
		await Promise.all(procs.map(async (proc) => proc.destroy()));
	}
}
