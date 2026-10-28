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
 * Observe grades and completion, optionally configure dedicated harness fixtures.
 *
 * @package    core_ltix
 * @copyright  2026 Matt Porritt <matt.porritt@moodle.com>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

define('CLI_SCRIPT', true);
require($argv[1] ?? '/var/www/html/config.php');
if (count($argv) < 4 || !ctype_digit($argv[2]) || !ctype_digit($argv[3])) {
    throw new InvalidArgumentException('Usage: script config.php cmid userid [--configure]');
}
require_once($CFG->libdir . '/gradelib.php');
require_once($CFG->libdir . '/completionlib.php');
require_once($CFG->dirroot . '/course/lib.php');
$cm = get_coursemodule_from_id('lti', (int)$argv[2], 0, false, MUST_EXIST);
$course = $DB->get_record('course', ['id' => $cm->course], '*', MUST_EXIST);
$userid = (int)$argv[3];
$user = $DB->get_record('user', ['id' => $userid], '*', MUST_EXIST);
$item = grade_item::fetch(['itemtype' => 'mod', 'itemmodule' => 'lti', 'iteminstance' => $cm->instance, 'itemnumber' => 0]);
if (!$item) {
    throw new RuntimeException('Activity grade item not found');
}
if (($argv[4] ?? '') === '--configure') {
    if (!str_starts_with($course->shortname, 'LTI-HARNESS-') || !str_starts_with($user->username, 'harness_')) {
        throw new RuntimeException('Configuration is restricted to dedicated LTI-HARNESS courses and harness_ test users');
    }
    if (empty($CFG->enablecompletion)) {
        throw new RuntimeException('Enable completion tracking in this test site before configuring the fixture');
    }
    $DB->set_field('course', 'enablecompletion', 1, ['id' => $course->id]);
    $course->enablecompletion = 1;
    $cm->completion = COMPLETION_TRACKING_AUTOMATIC;
    $cm->completiongradeitemnumber = 0;
    $cm->completionpassgrade = 1;
    $cm->completionview = 0;
    $DB->update_record('course_modules', (object)[
        'id' => $cm->id,
        'completion' => $cm->completion,
        'completiongradeitemnumber' => 0,
        'completionpassgrade' => 1,
        'completionview' => 0,
    ]);
    $item->gradepass = 50;
    $item->grademax = 100;
    $item->update();
    rebuild_course_cache($course->id, true);
}
$grade = $DB->get_record('grade_grades', ['itemid' => $item->id, 'userid' => $userid]);
$completion = $DB->get_record('course_modules_completion', ['coursemoduleid' => $cm->id, 'userid' => $userid]);
$configured = !empty($CFG->enablecompletion) && !empty($course->enablecompletion)
    && (int)$cm->completion === COMPLETION_TRACKING_AUTOMATIC
    && $cm->completiongradeitemnumber !== null && (int)$cm->completiongradeitemnumber === 0
    && !empty($cm->completionpassgrade) && (float)$item->gradepass === 50.0 && (float)$item->grademax === 100.0;
echo json_encode([
    'grade' => isset($grade->finalgrade) ? (float)$grade->finalgrade : null,
    'rawgrade' => isset($grade->rawgrade) ? (float)$grade->rawgrade : null,
    'gradeModified' => $grade->timemodified ?? null,
    'completion' => (int)($completion->completionstate ?? COMPLETION_INCOMPLETE),
    'completionModified' => $completion->timemodified ?? null,
    'completionConfigured' => $configured,
    'gradeToPass' => (float)$item->gradepass,
    'maximumGrade' => (float)$item->grademax,
    'cmid' => (int)$cm->id,
    'userid' => $userid,
], JSON_PRETTY_PRINT) . PHP_EOL;
