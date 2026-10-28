<?php
// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <https://www.gnu.org/licenses/>.

/**
 * Create dedicated real-platform fixtures on a current-main mod_lti test site.
 *
 * @package    mod_lti
 * @copyright  2026 Matt Porritt <matt.porritt@moodle.com>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

define('CLI_SCRIPT', true);
require($argv[1] ?? '/var/www/html/config.php');
require_once($CFG->libdir . '/testing/generator/lib.php');
require_once($CFG->dirroot . '/mod/lti/locallib.php');
\core\session\manager::set_user(get_admin());
$generator = new testing_data_generator();
$type = $DB->get_record('lti_types', ['name' => 'Harness real Moodle 1.3'], '*', MUST_EXIST);
$course = $DB->get_record('course', ['shortname' => 'LTI-HARNESS-20261028']);
if (!$course) {
    $course = $generator->create_course([
        'shortname' => 'LTI-HARNESS-20261028',
        'fullname' => 'LTI harness integration test',
        'numsections' => 1,
    ]);
}
$password = getenv('HARNESS_FIXTURE_PASSWORD');
if (!$password) {
    throw new RuntimeException('Set HARNESS_FIXTURE_PASSWORD for the synthetic test accounts');
}
$users = [];
foreach (['student', 'teacher'] as $role) {
    $username = 'harness_' . $role . '_20261028';
    $user = $DB->get_record('user', ['username' => $username]);
    if (!$user) {
        $user = $generator->create_user([
            'username' => $username,
            'password' => $password,
            'firstname' => 'Harness',
            'lastname' => ucfirst($role),
            'email' => $username . '@example.invalid',
        ]);
    }
    $generator->enrol_user($user->id, $course->id, $role === 'teacher' ? 'editingteacher' : 'student');
    $users[$role] = ['id' => (int)$user->id, 'username' => $username];
}
$generator->enrol_user(get_admin()->id, $course->id, 'editingteacher');
$legacy = $DB->get_record('lti_types', ['name' => 'Harness real Moodle 1.1']);
if (!$legacy) {
    $legacyid = lti_add_type(
        (object)['name' => 'Harness real Moodle 1.1', 'baseurl' => $type->baseurl, 'state' => 1],
        (object)[
            'lti_toolurl' => $type->baseurl,
            'lti_ltiversion' => 'LTI-1p0',
            'lti_resourcekey' => 'moodle-harness-legacy',
            'lti_password' => getenv('HARNESS_LEGACY_SECRET') ?: $password,
            'lti_sendname' => 1,
            'lti_sendemailaddr' => 1,
            'lti_acceptgrades' => 1,
            'lti_launchcontainer' => 5,
            'lti_coursevisible' => 1,
        ]
    );
    $legacy = $DB->get_record('lti_types', ['id' => $legacyid], '*', MUST_EXIST);
}
$activities = [];
foreach (['modern' => $type, 'legacy' => $legacy] as $key => $t) {
    $name = 'Harness ' . $key . ' launch';
    $activity = $DB->get_record('lti', ['course' => $course->id, 'name' => $name]);
    if (!$activity) {
        $activity = $generator->create_module('lti', [
            'course' => $course->id,
            'name' => $name,
            'typeid' => $t->id,
            'toolurl' => $t->baseurl,
            'resourcekey' => '',
            'password' => '',
            'launchcontainer' => 5,
            'grade' => 100,
            'instructorchoiceacceptgrades' => 1,
            'instructorchoicesendname' => 1,
            'instructorchoicesendemailaddr' => 1,
        ]);
    }
    $cm = get_coursemodule_from_instance('lti', $activity->id, $course->id, false, MUST_EXIST);
    $activities[$key] = [
        'id' => (int)$activity->id,
        'cmid' => (int)$cm->id,
        'url' => $CFG->wwwroot . '/mod/lti/view.php?id=' . $cm->id,
    ];
}
$urls = get_tool_type_urls($type);
require($CFG->dirroot . '/version.php');
echo json_encode([
    'wwwroot' => $CFG->wwwroot,
    'moodleRelease' => $release,
    'courseid' => (int)$course->id,
    'users' => $users,
    'activities' => $activities,
    'typeid' => (int)$type->id,
    'clientId' => $type->clientid,
    'deploymentIds' => [(string)$type->id],
    'authUrl' => $urls['authrequest'],
    'tokenUrl' => $urls['accesstoken'],
    'jwksUrl' => $urls['publickeyset'],
    'curlsecurityallowedport' => $CFG->curlsecurityallowedport ?? null,
    'config' => array_intersect_key(
        lti_get_type_config($type->id),
        array_flip(['ltiservice_gradesynchronization', 'ltiservice_memberships', 'launchcontainer'])
    ),
], JSON_PRETTY_PRINT) . PHP_EOL;
