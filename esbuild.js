const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
    name: 'esbuild-problem-matcher',
    setup(build) {
        build.onStart(() => {
            console.log('[watch] build started');
        });
        build.onEnd(result => {
            result.errors.forEach(({ text, location }) => {
                console.error(`✘ [ERROR] ${text}`);
                console.error(`    ${location.file}:${location.line}:${location.column}:`);
            });
            console.log('[watch] build finished');
        });
    },
};

/** Shared esbuild options */
const commonOptions = {
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    sourcesContent: false,
    platform: 'node',
    logLevel: 'silent',
    plugins: [
        esbuildProblemMatcherPlugin,
    ],
};

async function main() {
    // --- Extension bundle (runs inside VS Code extension host) ---
    const extCtx = await esbuild.context({
        ...commonOptions,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        external: ['vscode'],
    });

    if (watch) {
        await extCtx.watch();
    } else {
        await extCtx.rebuild();
        await extCtx.dispose();
    }
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
