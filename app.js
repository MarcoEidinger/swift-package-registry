var express = require('express');
var passport = require('passport');
var util = require('util');
var session = require('express-session');
var bodyParser = require('body-parser');
var methodOverride = require('method-override');
var GitHubStrategy = require('passport-github2').Strategy;
var partials = require('express-partials');
var octonode = require('octonode');
const url = require('url');
const process = require('process');
var flash = require('connect-flash');
var models  = require('./models');
const { Op } = require("sequelize");
const querystring = require('querystring');


var GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID  || "";
var GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";

var Docker = require('dockerode');
var docker = new Docker();
var fs = require('fs');

var github = require('octonode');

const { graphql } = require("@octokit/graphql");
// Passport session setup.
//   To support persistent login sessions, Passport needs to be able to
//   serialize users into and deserialize users out of the session.  Typically,
//   this will be as simple as storing the user ID when serializing, and finding
//   the user by ID when deserializing.  However, since this example does not
//   have a database of user records, the complete GitHub profile is serialized
//   and deserialized.
passport.serializeUser(function(user, done) {
  done(null, user);
});

passport.deserializeUser(function(obj, done) {
  done(null, obj);
});

var uuid = require('uuid');

// Use the GitHubStrategy within Passport.
//   Strategies in Passport require a `verify` function, which accept
//   credentials (in this case, an accessToken, refreshToken, and GitHub
//   profile), and invoke a callback with a user object.
passport.use(new GitHubStrategy({
    clientID: GITHUB_CLIENT_ID,
    clientSecret: GITHUB_CLIENT_SECRET,
    callbackURL: process.env.GITHUB_CALLBACK_URL || "http://127.0.0.1:3000/auth/github/callback"
  }, function(accessToken, refreshToken, profile, done) {
    // asynchronous verification, for effect...

    process.nextTick(function () {
        var client = octonode.client(accessToken);
        console.log(profile)
        models.User.findOrCreate({
            where: {
                github_id: profile.id
            },
            defaults: {
                github_id: profile.id,
                uuid: uuid.v5(profile.id.toString(), "5fbbd15b-dc52-4c15-94db-3c12fc523192"),
                accessToken: accessToken,
                passport_github2_raw: JSON.stringify(profile),
                github_login: profile.username
            }
        }).then(function(users, created) {
            const user = users[0];

            user.github_login = profile.username;
            user.accessToken = accessToken;

            if (user.github_id == "1085707") {
                user.isAdmin = true
                user.isMod = true
            }

            user.save()

            console.log(user)


            return done(null, user);
        });
    });
}));

// db
var db = require('./models')
db.sequelize.authenticate();
db.sequelize.sync({alter: true});

var app = express();

// configure Express
app.set('views', __dirname + '/views');
app.set('view engine', 'ejs');
app.use(partials());
app.use(flash())
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(methodOverride());
app.use(session({ secret: 'keyboard cat', resave: false, saveUninitialized: false }));
// Initialize Passport!  Also use passport.session() middleware, to support
// persistent login sessions (recommended).
app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(__dirname + '/public'));

// https://stackoverflow.com/a/15773824/193772
app.use(function(req, res, next) {
    if (req.path.substr(-1) == '/' && req.path.length > 1) {
        var query = req.url.slice(req.path.length);
        res.redirect(301, req.path.slice(0, -1) + query);
    } else {
        next();
    }
});

app.get('/', function(req, res){
  models.Package.findAll({
    where: {
        processing: false,
        processing_error: null
    },
    limit: 50,
    order: [[models.sequelize.col('github_stars'), 'DESC']]
  }).then(function(popular_packages) {
    models.Package.findAll({
      where: {
          processing: false,
          processing_error: null
      },
      limit: 25,
      order: [[models.sequelize.col('createdAt'), 'DESC']]
    }).then(function(recently_created_packages) {
      res.render('index', {user: req.user, popular_packages: popular_packages, recently_created_packages: recently_created_packages})
    })
  })
});

app.get('/add', function(req, res) {
  res.render('add', {user: req.user, title:"Add Package", flash: req.flash()})
})

app.get('/all', function(req, res) {
  models.Package.findAll({
    where: {
        processing: false,
    },
    order: [[models.sequelize.col('full_name'), 'ASC'], [models.sequelize.col('name'), 'DESC']]
  }).then(function(packages) {
      res.render('packages', {user: req.user, packages: packages, title: "All Packages"})
  })
});

app.get('/account', ensureAuthenticated, function(req, res){
    let pageSize = 50;
    let currentPage = parseInt(req.query.page) || 1;
    let me = octonode.client(req.user.accessToken).me();

    me.info(function(err, info) {
        if (err) {
            // todo: render error
            return
        }
        me.repos({
            page: currentPage,
            per_page: pageSize
        }, function(err, repos, h) {
            if(err) {
                // todo: render error
                return
            }
            console.log("me", me)
            console.log("repos", repos)

            let nextPage = currentPage + 1;
            res.render('account', { user: req.user, repos: repos, user_info: info, page:currentPage, pageSize:pageSize, nextPage:nextPage, title: "Account"});
        });
    })
});

app.get('/login', function(req, res){
    res.render('login', {user: req.user, title: "Login"} );
});

// GET /auth/github
//   Use passport.authenticate() as route middleware to authenticate the
//   request.  The first step in GitHub authentication will involve redirecting
//   the user to github.com.  After authorization, GitHub will redirect the user
//   back to this application at /auth/github/callback
app.get('/auth/github',
  passport.authenticate('github', { scope: [ 'user:email' ] }),
  function(req, res){
    // The request will be redirected to GitHub for authentication, so this
    // function will not be called.
  });

// GET /auth/github/callback
//   Use passport.authenticate() as route middleware to authenticate the
//   request.  If authentication fails, the user will be redirected back to the
//   login page.  Otherwise, the primary route function will be called,
//   which, in this example, will redirect the user to the home page.
app.get('/auth/github/callback', 
  passport.authenticate('github', { failureRedirect: '/login' }),
  function(req, res) {
    res.redirect('/account');
  });

app.get('/logout', function(req, res){
  req.logout();
  res.redirect('/');
});

app.get('/:user/:repo', function(req, res) {
    let full_name = req.params.user + '/' + req.params.repo
  models.Package.findOne({
    where: {
      full_name: {
            [Op.iLike]: full_name
        }
    }
  }).then(function(package) {
    if (!package) {
        res.render('404', {user: req.user, req: req})
        return
    }
    if(package.full_name != full_name) {
        res.redirect('/' + package.full_name)
        return
    }
    if (package) {

        if(!req.user) {
            res.render('repo', {user: req.user, package: package, title: package.name || package.full_name, repo_info: null})
        } else {
            var client = github.client(req.user.accessToken);
            var ghrepo = client.repo(package.full_name);
            ghrepo.info(function(err, repo_info) {
                console.log(repo_info, req.user)
                res.render('repo', {user: req.user, package: package, title: package.name || package.full_name, repo_info: repo_info})
            })
        }
    } else {
      res.render('404', {user: req.user, req: req} )
    }
  }).catch(function(error) {
    console.log("did catch");
    console.error(error);
  });
});

app.get('/processing', function(req, res) {
    models.Package.findAll({
    where: {
        processing: true,
    },
    order: [[models.sequelize.col('full_name'), 'ASC'], [models.sequelize.col('name'), 'DESC']]
  }).then(function(packages) {
      res.render('packages', {user: req.user, packages: packages, title: "All Packages"})
  })
})

app.post('/delete/:id', ensureAdmin, function(req, res) {
    models.Package.findOne({
        where: {
            id: req.params.id
        }
    }). then(function(package) {
        if(package) {
            package.destroy()
        }
        res.redirect("/")
    })
});

app.get('/broke', function(req, res) {
    models.Package.findAll({
    where: {
        processing_error: {
            [Op.ne]: null
        }
    },
    order: [[models.sequelize.col('full_name'), 'ASC'], [models.sequelize.col('name'), 'DESC']]
  }).then(function(packages) {
      res.render('packages', {user: req.user, packages: packages, title: "All Packages"})
  })
})

app.get('/about', function(req, res) {
  fs.readFile('README.md', 'utf-8', function(err, contents) {
    if(err) {
      res.render('about', {user: req.user, title: "About", readme: err})
      return;
    }
    var url = new URL("https://github.com/twodayslate/swift-package-registry/")
    url.hostname = "raw.githubusercontent.com"
    url.pathname = url.pathname + "/master";
    var marked = require('marked');
    marked.setOptions({
        baseUrl: url.toString(),
        renderer: new marked.Renderer(),
        highlight: function(code, language) {
            const hljs = require('highlight.js');
            const validLanguage = hljs.getLanguage(language) ? language : 'plaintext';
            return hljs.highlight(validLanguage, code).value;
          },
          gfm: true,
          breaks: false,
    });

    res.render('about', {user: req.user, title: "About", readme: marked(contents)})
  })
});


app.get("/search", function(req, res) {
  var wildcard = "%%"
  var term = ""
  var orStatement = []
  var andStatement = []

  // todo: improve search


  if (Array.isArray(req.query.term)) {
    wildcard = ""
    req.query.term.forEach(function(term) {
        wildcard = wildcard + "%" + term
    });
    wildcard = wildcard + "%"
    term = req.query.term[0]
  } else {
    term = req.query.term || "";
    wildcard = '%' + term + "%"
  }

  if (wildcard != "" && wildcard != "%%") {
    orStatement.push({
        full_name: { [Op.iLike]: wildcard}
    })

    orStatement.push({
        github_description: { [Op.iLike]: wildcard}
    })
  }
  
  if (Array.isArray(req.query.topic)) {
    andStatement.push({
        github_topics: { [Op.contains]: req.query.topic}
    })
  } else {
    let topic =  req.query.topic || ""
    if (topic != "") {
        orStatement.push({
            github_topics: { [Op.contains]: [topic]}
        })
      }
  }


    var where = {
        processing: false,
    }

      if (orStatement && orStatement.length > 0) {
        where[Op.or] =  orStatement
      }

      if (andStatement && andStatement.length > 0) {
        where[Op.and] = andStatement
      }

      console.log(where)

  models.Package.findAll({
    where: where,
    order: [[models.sequelize.col('github_stars'), 'DESC'], [models.sequelize.col('name'), 'DESC']]
  }).then(function(packages) {
      res.render('search', {user: req.user, packages: packages, term: term, title: term + " Search"})
  })
});

function runCommand(container, cmd, workDir, callback) {
    workDir = workDir || "/usr/src/twodayslate"
    container.exec({Cmd: cmd, AttachStdin: true, AttachStdout: true, AttachStderr: true, WorkingDir: workDir}, function(err, exec) {
        if(err) { console.log(err); return callback(err);}
        exec.start({}, function(err, stream) {
            if(err) { console.log(err); return callback(err); }
            var nextDataType = null;
            var nextDataLength = null;
            var buffer = Buffer.from('');
            var finished = false;

            var stdout_content = "";
            var stderr_content = "";

            function processData(data) {
                if (data) {
                    buffer = Buffer.concat([buffer, data]);
                }
                if (!nextDataType) {
                    if (buffer.length >= 8) {
                        var header = bufferSlice(8);
                        nextDataType = header.readUInt8(0);
                        nextDataLength = header.readUInt32BE(4);
                        // It's possible we got a "data" that contains multiple messages
                        // Process the next one
                        processData();
                    }
                } else {
                    if (buffer.length >= nextDataLength) {
                        var content = bufferSlice(nextDataLength);
                        if (nextDataType === 1) {
                            stdout_content += content;
                            //process.stdout.write(content);
                        } else {
                            stderr_content += content;
                            //process.stderr.write(content);
                        }
                        nextDataType = null;
                        // It's possible we got a "data" that contains multiple messages
                        // Process the next one
                        processData();
                    }
                }
            }

            function bufferSlice(end) {
                var out = buffer.slice(0, end);
                buffer = Buffer.from(buffer.slice(end, buffer.length));
                return out;
            }

            function didClose() {
                if (!finished) {
                    exec.inspect(function(err, data) {
                        callback(err, stdout_content, stderr_content, data);
                    });
                }
                finished = true;
            }
            function onStreamError(err) {
                console.log("did get an error");
                finished = true;
                stream.removeListener('data', processData);
                stream.removeListener('error', onStreamError);
                stream.removeListener('close', didClose);
                stream.removeListener('end', didClose);
                callback(err, stdout_content, stderr_content);
            }

            stream.on('data', processData);
            stream.on('close', didClose);
            stream.on('end', didClose);
            stream.on('error', onStreamError);
        });
    });
}

function parsePackage(ghrepo, swift_version, callback) {
    swift_version = swift_version || "latest"
    console.log("going to try", swift_version)
    ghrepo.info(function(err, repo_info) {
        if(err) { console.log(err); return callback(err, ghrepo); }
        console.log("info", repo_info);
        ghrepo.releases(function(err, repo_releases) {
            if(err) { console.log(err); return callback(err, ghrepo); }
            var release_tag = repo_info.default_branch;
            var repo_release = undefined;
            if (repo_releases.length > 0) {
              console.log("has releases")
              repo_releases.some(function(ele) {
                console.log(ele);
                if (!ele.draft && !ele.prerelease) {
                  repo_release = ele;
                  return true
                }
              });

              console.log("release", repo_release);
              release_tag = repo_release.tag_name
            } else {
              console.log("does not have any releases");
            }

            docker.pull('swift:'+swift_version, function (err, stream) {
                if(err) {
                    console.log(err);
                    return callback(err, ghrepo)
                }
                 docker.createContainer({Image: 'swift:'+swift_version, Cmd: ['/bin/bash'], AutoRemove: true, Tty: true,}, function (err, container) {
                    if(err) { console.log(err); return callback(err, ghrepo); }
                    container.start(function (err) {
                        if(err) { console.log(err); return callback(err, ghrepo); }
                        runCommand(container, ['git', 'clone', '--recursive', '--branch', release_tag, repo_info.clone_url, repo_info.name], "/", function(err, stdout, stderr, inspect_data) {
                            if(err) { console.log(err); return callback(err, ghrepo); }
                            if(inspect_data.ExitCode != 0) { 
                              console.log("exit code not zero", stdout, stderr, inspect_data);
                              return callback(stderr || stdout, ghrepo);
                            }
                            console.log(stdout, stderr);
                            runCommand(container, ['cat', 'README.md'], '/' + repo_info.name, function(err, stdout, stderr, inspect_data) {
                                if(err) { console.log(err); return callback(err, ghrepo); }
                                //if(inspect_data.ExitCode != 0) { console.log("exit code not zero", stdout, stderr, inspect_data); return callback(err, ghrepo);; }
                                //console.log(stdout);
                                var url = new URL(repo_info.html_url)
                                url.hostname = "raw.githubusercontent.com"
                                url.pathname = url.pathname + "/" + release_tag
                                var marked = require('marked');
                                marked.setOptions({
                                    baseUrl: url,
                                    renderer: new marked.Renderer(),
                                    highlight: function(code, language) {
                                        const hljs = require('highlight.js');
                                        const validLanguage = hljs.getLanguage(language) ? language : 'plaintext';
                                        return hljs.highlight(validLanguage, code).value;
                                      },
                                      gfm: true,
                                      breaks: true,
                                });
                                var readme = stdout
                                try {
                                  readme = stdout
                                } catch(err) {
                                  readme = err.message;
                                }

                                runCommand(container, ['swift', 'package', 'tools-version'], "/" + repo_info.name, function(err, stdout, stderr, inspect_data) {
                                    if(err) { console.log(err); return callback(err, ghrepo, readme); }
                                    if(inspect_data.ExitCode != 0) { 
                                      console.log("exit code not zero when getting tools-version", stdout, stderr, inspect_data); 
                                      return callback(stderr || stdout, ghrepo, readme); 
                                    }
                                    var tool_version = stdout.trim();
                                    console.log(tool_version);
                                    runCommand(container, ['swift', 'package', 'describe', '--type=json'], "/" + repo_info.name, function(err, stdout, stderr, inspect_data) {
                                        if(err) { console.log(err); return callback(err, ghrepo, readme, tool_version); }
                                        if(inspect_data.ExitCode != 0) { 
                                          console.log("exit code not zero when describing package", stdout, stderr, inspect_data); 
                                          return callback(stderr || stdout, ghrepo, readme, tool_version);
                                        }
                                        console.log(stdout);
                                        var description = stdout;
                                        runCommand(container, ['swift', 'package', 'show-dependencies', '--format=json'], "/" + repo_info.name, function(err, stdout, stderr, inspect_data) {
                                            if(err) { console.log(err); return callback(err, ghrepo, readme, tool_version, description); }
                                            if(inspect_data.ExitCode != 0) { 
                                              console.log("exit code not zero when getting dependencies", stdout, stderr, inspect_data); 
                                              return callback(stderr, ghrepo, readme, tool_version, description);
                                            }
                                            console.log(stdout);
                                            container.stop(function (err, data) {
                                                container.remove(function (err, data) {
                                                    console.log("done :)")
                                                    return callback(null, ghrepo, readme, tool_version, description, stdout, release_tag, repo_release, repo_info);
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}


app.post('/add', ensureAuthenticated, function(req, res) {
  var parsedUrl;
  try {
    parsedUrl = new URL(req.body.url);
  } catch(err) {
    req.flash('error', 'Invalid GitHub URL')
    res.redirect('add')
    return
  }
  
  if(parsedUrl.hostname == "github.com") {
    let full_name = parsedUrl.pathname.replace(".git","").replace(/^\/|\/$/g, ''); // https://stackoverflow.com/a/3840645/193772
    if (full_name.split("/").length != 2) {
      req.flash('error', 'Invalid GitHub URL')
      res.redirect('add')
      return
    }

    models.Package.findOrCreate({
      where: { full_name: full_name },
      defaults: {
        full_name: full_name,
        processing: true
      }
    }).then(function(package, created) {
      package = package[0]
      var client = github.client(req.user.accessToken);
      var ghrepo = client.repo(full_name);
      var versions = ["latest", "5.1", "5.0", "4.2", "4.1", "4.0", "3.1"];
      var index = 0;

      function cb(err, repo, readme, tool_version, description, dependencies, release_tag, repo_release, repo_info) {
          console.log("in cb")
          console.log(err, repo)
          if(err) { 
            console.log("got an err")
              console.log(err);
              index = index +1;
              if (index < versions.length) {
                  parsePackage(ghrepo, versions[index], cb);
              }
              package.processing = false;
              package.processing_error = err;
              package.save()
              return;
          }

          package.github_repo_raw = repo_info.toString()

          if(repo_info) {
            package.github_repo_info_raw = repo_info.toString()

            var url = new URL(repo_info.html_url)
            url.hostname = "raw.githubusercontent.com"
            url.pathname = url.pathname + "/" + release_tag;
            var marked = require('marked');
            marked.setOptions({
                baseUrl: url.toString(),
                renderer: new marked.Renderer(),
                highlight: function(code, language) {
                    const hljs = require('highlight.js');
                    const validLanguage = hljs.getLanguage(language) ? language : 'plaintext';
                    return hljs.highlight(validLanguage, code).value;
                  },
                  gfm: true,
                  breaks: false,
            });

            package.name = repo_info.name
            package.full_name = repo_info.full_name
            package.github_html_url = repo_info.html_url;
            package.github_default_branch = repo_info.default_branch;
            package.github_clone_url = repo_info.clone_url;
            package.github_id = repo_info.id
            package.github_description = repo_info.description;
            package.github_stars = repo_info.stargazers_count;

            try {
              package.readme_html = marked(readme);
            } catch(err) {
              package.readme_html = err.message;
            }
          }

          const graphqlWithAuth = graphql.defaults({
              headers: {
                authorization: 'token ' + req.user.accessToken
              }
            });

          const { tags } = graphqlWithAuth({query: `
              query topics($owner: String!, $repo: String!) {
                  repository(owner: $owner, name: $repo) {
                    repositoryTopics(first: 10) {
                      edges {
                        node {
                          topic {
                            name
                          }
                        }
                      }
                    }
                  }
                }
            `, 
                owner: repo_info.owner.login,
                repo: repo_info.name
            }).then(function(tags, thing) {
                package.github_topics = [];
                tags.repository.repositoryTopics.edges.forEach(function(tag) {
                    package.github_topics.push(tag.node.topic.name)
                })

                package.save()
            });

          console.log('tags')
          console.log(tags)

          package.processing_error = undefined;

          
          package.swift_tool_version = tool_version;
          package.swift_describe_raw = description;
          package.swift_dependencies_raw = dependencies;
          

          package.readme_raw = readme;
        
          package.github_release_tag = release_tag;

          if(repo_release) {
            package.github_release_raw = repo_release.toString()
            package.github_release_name = repo_release.name;
            package.github_release_body = marked(repo_release.body);
            package.github_release_date = repo_release.published_at
            package.github_release_html_url = repo_release.html_url
          }
          package.processing = false;

          //console.log(package)

          package.save()
      }
      try {
        parsePackage(ghrepo, versions[index], cb);
      } catch(err) {
        package.processing = false;
        package.processing_error = err.message || err.toString();
        package.save()
      };

      res.redirect(full_name);
    })
  } else {
    req.flash('error', "Invalid GitHub URL");
    res.redirect('add')
  }
});

app.listen(3000);

// Simple route middleware to ensure user is authenticated.
//   Use this route middleware on any resource that needs to be protected.  If
//   the request is authenticated (typically via a persistent login session),
//   the request will proceed.  Otherwise, the user will be redirected to the
//   login page.
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) { return next(); }
  res.redirect('/login')
}

function ensureMod(req, res, next) {
    if (req.isAuthenticated() && req.user.isMod) {
        return next()
    }

    res.redirect('/login')
}

function ensureAdmin(req, res, next) {
    if (req.isAuthenticated() && req.user.isAdmin) {
        return next()
    }

    res.redirect('/login')
}
