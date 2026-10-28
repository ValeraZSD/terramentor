// Imported FIRST by server/index.js, for its side effect alone.
//
// ES modules run in import order, and server/database.js opens (and, on a
// fresh install, creates) the library while it is being imported. A umask set
// in index.js's own body would come after that; set in a module imported
// before anything else, it is in place before the first file is made.
//
// 077 means everything this process creates — the library, its WAL, the vault,
// a log, a temporary file — is for the account that runs it only. The code
// that makes the library's own files sets their modes too (privateFiles.js);
// this covers everything else. Windows guards files with ACLs and ignores the
// umask, so it is not set there.

if (process.platform !== 'win32') process.umask(0o077);
