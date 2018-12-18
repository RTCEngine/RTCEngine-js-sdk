'use strict';


const DEV_OUTPUT_DIR = 'dist/'; // eslint-disable-line no-unused-vars

const browserify = require('browserify');
const vinyl_source_stream = require('vinyl-source-stream');
const gulp = require('gulp');
const eslint = require('gulp-eslint');
const plumber = require('gulp-plumber');
const minify = require('gulp-minify');
const rename = require('gulp-rename');
const filelog = require('gulp-filelog');
const replace = require('gulp-replace');
const header = require('gulp-header');
const expect = require('gulp-expect-file');
const fs = require('fs');
const path = require('path');
const ip  =  require('ip');
const del = require('del');
const browserSync = require('browser-sync');


const PKG_INFO = require('./package.json');

// Build filenames.
const BUILDS = {
		uncompressed: PKG_INFO.name + '.js',
		compressed: PKG_INFO.name + '-' + PKG_INFO.version  +'.min.js'
	};

// gulp-header.
const BANNER = fs.readFileSync('banner.txt').toString();

const BANNER_OPTS = {
		pkg: PKG_INFO,
		currentYear: (new Date()).getFullYear()
	};

// gulp-expect-file options.
const EXPECT_OPTS = {
		silent: true,
		errorOnFailure: true,
		checkRealFile: true
	};

const JS_FILES = ['gulpfile.js', 'lib/*.js'];



// gulp.task('dev-config', function() {

// 	return gulp.src('lib/config.production.js')
// 		.pipe(replace('janus.dot.cc','dotengine.dot.cc'))
//         .pipe(replace('TestToken','TestToken?from=web'))
// 		.pipe(rename('config.js'))
// 		.pipe(gulp.dest('lib/'));
// });


// gulp.task('production-config', function(){

// 	return gulp.src('lib/config.production.js')
// 		.pipe(rename('config.js'))
// 		.pipe(gulp.dest('lib/'));

// });

gulp.task('clean', () => del(DEV_OUTPUT_DIR,{force:true}))


gulp.task('lint', function () {
	return gulp.src(JS_FILES)
		.pipe(plumber())
		.pipe(eslint({
			plugins: ['import'],
			extends : [ 'eslint:recommended' ],
			envs:
			[
				'browser',
				'es6',
				'node'
			],
			rules:
			{
				'no-console'                         : 0,
				'no-undef'                           : 2,
				'no-unused-vars'                     : [ 2, { vars: 'all', args: 'after-used' }],
				'no-empty'                           : 0,
			},
			parserOptions: {
				sourceType: 'module',
				ecmaVersion: 2017
			}
		})).pipe(eslint.format());
});


gulp.task('browserify', function () {
	return browserify({
			entries	: path.join(__dirname,PKG_INFO.main),
			extensions: ['.js']
		})
		.transform('babelify',{
			presets : [ 'es2015' ],
			plugins : [ 'transform-runtime', 'transform-object-assign' ]
		})
		.bundle()
			.pipe(vinyl_source_stream(PKG_INFO.name + '.js'))
			.pipe(filelog('browserify'))
			.pipe(header(BANNER, BANNER_OPTS))
			.pipe(rename(BUILDS.uncompressed))
			.pipe(gulp.dest(DEV_OUTPUT_DIR));
});


gulp.task('uglify', function () {
	var src = DEV_OUTPUT_DIR + BUILDS.uncompressed;
	return gulp.src(src)
		.pipe(filelog('uglify'))
		.pipe(expect(EXPECT_OPTS, src))
		.pipe(minify())
		.pipe(header(BANNER, BANNER_OPTS))
		.pipe(rename(BUILDS.compressed))
		.pipe(gulp.dest('dist/'));
});



gulp.task('livebrowser', (done) =>
{

    let host = ip.address();
    console.log('host: ', host);
	browserSync(
		{
			open   : 'local',
			server :
			{
				baseDir : DEV_OUTPUT_DIR
			},
			https     : false,
			ghostMode : false,
			files     : path.join(DEV_OUTPUT_DIR, '**', '*')
		});

	done();
});


gulp.task('html', () =>
{
	return gulp.src(['example/index.html'])
        .pipe(replace('=timestamp','='+ Math.random().toString(36).substring(7)))
		.pipe(gulp.dest(DEV_OUTPUT_DIR));
});


gulp.task('watch', (done) =>
{
	// Watch changes in HTML.
	gulp.watch([ 'example/index.html'], gulp.series(
		'html'
	));

	// Watch changes in JS files.
	gulp.watch([ 'gulpfile.js', 'lib/*.js' ], gulp.series(
		'lint',
        'browserify',
        'html'
	));

	done();
});

gulp.task('live', gulp.series(
    'clean',
    'lint',
    'browserify',
    'html',
    'watch',
    'livebrowser'    
));

gulp.task('dev', gulp.series('lint', 'browserify','html'));

gulp.task('dist', gulp.series('lint', 'browserify', 'uglify'));

gulp.task('default', gulp.series('live'));
