<?php
/** GET-only CLI transport for the unchanged production API. Never opens a socket. */
declare(strict_types=1);
if (PHP_SAPI !== 'cli' || $argc !== 3 || !is_file($argv[1])) {
    fwrite(STDERR, "Usage: php php-bridge.php /absolute/frontend/api.php query-string\n");
    exit(2);
}
$_GET = [];
parse_str($argv[2], $_GET);
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['HTTP_HOST'] = 'localhost';
$_SERVER['REQUEST_URI'] = '/api.php' . ($argv[2] ? '?' . $argv[2] : '');
$_SERVER['SCRIPT_FILENAME'] = $argv[1];
$_SERVER['SCRIPT_NAME'] = '/api.php';
$_SERVER['SERVER_PROTOCOL'] = 'HTTP/1.1';
register_shutdown_function(static function (): void {
    $status = http_response_code();
    fwrite(STDERR, "\n__REVIEW_HTTP_STATUS__:" . ($status === false ? 200 : $status) . "\n");
});
require $argv[1];
