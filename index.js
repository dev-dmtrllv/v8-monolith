const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");
const { createInterface } = require("readline");
const os = require("os");
const https = require("https");
const archiver = require("archiver");

const THIRD_PARTY = "third_party";
const ROOT_DIR = path.resolve(__dirname);
const resolve = (...p) => path.resolve(ROOT_DIR, ...p);

const rl = createInterface(process.stdin, process.stdout);

const getInput = (q, defaultValue) => new Promise((res) => rl.question(q, r => res(r || defaultValue)));

const getUserInput = async (prop, options = [], defaultValue = "") =>
{
	options = options.map(s => s.toLowerCase());

	const matchOptions = (m) =>
	{
		if (options.length === 0)
			return true;
		return options.includes(m.toLowerCase());
	}

	const str = `${prop} [${options.join(", ")}]: (${defaultValue}) `

	let r = await getInput(str, defaultValue);

	while (!matchOptions(r))
		r = await getInput(str, defaultValue);

	return r;
}

const V8 = "v8";
const BUILD = "build"
const DEPOT_TOOLS = "depot_tools"

const paths = {
	thirdParty: resolve(THIRD_PARTY),
	depot_tools: resolve(THIRD_PARTY, DEPOT_TOOLS),
	v8: resolve(THIRD_PARTY, V8),
	v8Src: resolve(THIRD_PARTY, V8, V8),
	v8Out: resolve(THIRD_PARTY, V8, V8, "out.gn"),
	build: resolve(BUILD),
	buildIncludes: resolve(BUILD, "include"),
	releases: resolve("releases")
};

const genLibPaths = () =>
{
	const oss = ["win32", "linux", "darwin"];
	const platforms = ["x86", "x64"];
	const buildTypes = ["Release", "Debug"];

	mkdirp(paths.build);
	for (const o of oss)
	{
		mkdirp(paths.build, o);
		for (const p of platforms)
		{
			mkdirp(paths.build, o, p);
			for (const t of buildTypes)
			{
				mkdirp(paths.build, o, p, t);
			}
		}
	}
}

const LOG = (msg) => console.log(`\n----------  ${msg}  ----------\n`);

const run = (cmd, args, cwd = paths.thirdParty) => new Promise((res, rej) => 
{
	let p;

	console.log(`\nrunning command: ${cmd}\nwith args: ${args.join(" ")}\nin dir: ${cwd}\n`);

	p = exec(`${cmd} ${args.join(" ")}`, { cwd, env: process.env });

	p.stdout.pipe(process.stdout);
	p.stdin.pipe(process.stdin);
	p.stderr.pipe(process.stderr);
	p.on("exit", res);
	p.on("error", rej);
});

const mkdirp = (...dirs) => 
{
	const dir = path.join(...dirs);
	!fs.existsSync(dir) && fs.mkdirSync(dir);
};

const downloadDepotTools = () => new Promise((res, rej) => 
{
	const p = path.resolve(paths.thirdParty, "depot_tools.zip");
	const ws = fs.createWriteStream(p);

	const req = https.get("https://storage.googleapis.com/chrome-infra/depot_tools.zip", (response) =>
	{
		if (response.statusCode !== 200)
		{
			rej(new Error(`Failed to get '${url}' (${response.statusCode})`));
		}
		else
		{
			response.pipe(ws);
		}
	});

	req.on("close", () => res(p));
	req.on("error", (e) => { console.log(e); process.exit(0); });
});

const unzipDepotTools = (zipPath) => new Promise((res, rej) => 
{
	const s = fs.createReadStream(zipPath)
	s.on("close", () =>
	{
		fs.unlinkSync(zipPath);
		res();
	});
	s.on("error", rej);
	const unzip = require("unzipper");
	s.pipe(unzip.Extract({ path: paths.depot_tools }));
});

const setupDepotTools = async () =>
{
	LOG("setting up depot tools");
	if (os.platform() == "win32")
	{
		const zipPath = await downloadDepotTools();
		await unzipDepotTools(zipPath);
	}
	else
	{
		await run("git", ["clone", "https://chromium.googlesource.com/chromium/tools/depot_tools.git"]);
		await run("gclient", []);
	}
}

const fetchV8 = async () =>
{
	LOG("fetching v8 source");
	await run("fetch", [V8], paths.v8);
	await run("gclient", ["sync"], paths.v8Src);
	if (os.platform() != "win32")
		await run("./build/install-build-deps.sh", [], paths.v8Src);
}

const getV8OutPath = (args) => `out.gn/${String(args.target_cpu).replace(/\"/g, "")}.${args.is_debug ? "debug" : "release"}`;

const buildV8 = async (outPath, args) =>
{
	const libName = os.platform() == "win32" ? "v8_monolith.lib" : "libv8_monolith.a";
	const buildPath = path.resolve(paths.v8Src, outPath, "obj", libName);
	if (!fs.existsSync(buildPath))
	{
		let argStr = "";
		for (const k in args)
			argStr += `${k}=${args[k]} `;

		argStr = argStr.trim().replace(/\"/g, "\\\"");

		LOG("Generating compilation arguments");
		await run("gn", ["gen", outPath, `--args="${argStr}"`], paths.v8Src);
		await run("ninja", ["-C", outPath, args.v8_monolithic ? "v8_monolith" : V8], paths.v8Src);
	}

	LOG(`Copying ${path.resolve(paths.v8Src, outPath, "obj", libName)}...`);
	const copyPath = resolve(paths.depLibs, os.platform(), args.target_cpu.replace(/"/g, ""), args.is_debug ? "Debug" : "Release", libName);

	if (fs.existsSync(copyPath))
		fs.unlinkSync(copyPath);

	fs.copyFileSync(buildPath, copyPath);
}

const execFn = async (cb) => await cb();

execFn(async () =>
{
	genLibPaths();

	const buildAll = (await getUserInput("Build all? (Release and Debug for x86 and x64) ", ["y", "n"], "y")).toLowerCase() == "y";
	const isDebug = buildAll ? true : await getUserInput("is debug build", ["true", "false"], "false") == "true";
	const platform = buildAll ? "x64" : `"${await getUserInput("target cpu", ["x64", "x86"], "x64")}"`;
	let useClang = os.platform() != "win32";
	// const isMonolith = await getUserInput("monolith", ["true", "false"], "false") == "true";
	// const i18Support = await getUserInput("enable i18n support", ["true", "false"], "false") == "true";
	// const useSnapShot = await getUserInput("use snapshots", ["true", "false"], "false") == "true";
	// const useCustomLibCXX = await getUserInput("use custom libcxx", ["true", "false"], "false") == "true";
	// const useExternalStartupData = isMonolith ? false : await getUserInput("external startup data", ["true", "false"], "true") == "true";

	if (os.platform() == "win32")
	{
		if (process.env.DEPOT_TOOLS_WIN_TOOLCHAIN === undefined)
		{
			const r = await getUserInput("use locally installed toolchain?", ["y", "n"], "y");
			if (r.toLowerCase() === "y")
				process.env.DEPOT_TOOLS_WIN_TOOLCHAIN = 0;
		}

		if (process.env.GYP_MSVS_VERSION === undefined)
			process.env.GYP_MSVS_VERSION = Number(await getUserInput("set MSVC version", ["2015, 2017", "2019"], "2019"));
	}
	else
	{
		const r = await getUserInput("use clang?", ["y", "n"], "y");
		useClang = r.toLowerCase() === "y";
	}

	const args = {
		is_debug: isDebug,
		target_cpu: platform,
		v8_target_cpu: platform,
		is_component_build: false,
		v8_static_library: true,
		v8_monolithic: true,
		v8_use_external_startup_data: false,
		v8_enable_test_features: false,
		v8_enable_i18n_support: false,
		treat_warnings_as_errors: false,
		symbol_level: 0,
		v8_use_snapshot: false,
		is_clang: useClang,
		use_sysroot: false,
		use_custom_libcxx: false
	};

	const pathSep = os.platform() == "win32" ? ";" : ":";
	process.env.PATH = [paths.depot_tools, ...process.env.PATH.split(pathSep).filter(s => !!s)].join(pathSep);

	mkdirp(paths.thirdParty);

	if (!fs.existsSync(paths.depot_tools))
		await setupDepotTools();

	mkdirp(paths.v8);

	if (!fs.existsSync(paths.v8Src))
		await fetchV8();

	if (!fs.existsSync(paths.buildIncludes))
		fs.cpSync(path.join(paths.v8Src, "include"), paths.buildIncludes, { recursive: true });

	if (buildAll)
	{
		// X64
		args.target_cpu = `"x64"`;
		args.v8_target_cpu = `"x64"`;
		// Debug build
		args.is_debug = true;
		args.symbol_level = 2;
		await buildV8(getV8OutPath(args), args);
		// Release build
		args.is_debug = false;
		args.symbol_level = 0;
		await buildV8(getV8OutPath(args), args);

		if (os.platform() !== "linux") // Ubuntu 20.04 wont build x86 version for some reason...
		{
			// X86
			args.target_cpu = `"x86"`;
			args.v8_target_cpu = `"x86"`;
			// Debug build
			args.is_debug = true;
			args.symbol_level = 2;
			await buildV8(getV8OutPath(args), args);
			// Release build
			args.is_debug = false;
			args.symbol_level = 0;
			await buildV8(getV8OutPath(args), args);
		}

		// create release zip
		mkdirp(paths.releases);

		const versionsFile = path.resolve(__dirname, "..", "third_party", "v8", "v8", "include", "v8-version.h");

		const targets = ["V8_MAJOR_VERSION", "V8_MINOR_VERSION", "V8_BUILD_NUMBER", "V8_PATCH_LEVEL"];

		let foundTargets = [0, 0, 0, 0];

		fs.readFileSync(versionsFile, "utf-8").split("\n").filter(s => 
		{
			const f = targets.find(target => s.split(" ").includes(target));
			if (f)
			{
				const index = targets.indexOf(f);
				foundTargets[index] = s.substring(s.indexOf(f) + f.length + 1, s.length);
			}
		});

		const version = foundTargets.join(".");
		const releaseZipPath = path.resolve(paths.releases, `v8-${version}-${os.platform()}.zip`);
		const ws = fs.createWriteStream(releaseZipPath);
		const archive = archiver("zip");
		archive.on("close", () => 
		{
			console.log("Done! :D");
			process.exit();
		});
		archive.pipe(ws);
		archive.directory(paths.buildIncludes, 'include');
		archive.directory(path.resolve(paths.build, os.platform()));
		archive.finalize();
	}
	else
	{
		await buildV8(v8OutPath, args);
	}

	rl.removeAllListeners();
	rl.close();
});
