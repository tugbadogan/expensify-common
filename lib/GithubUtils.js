import _ from 'underscore';
import semverParse from 'semver/functions/parse';
import semverSatisfies from 'semver/functions/satisfies';

export const GITHUB_OWNER = 'Expensify';
export const EXPENSIFY_ISSUE_REPO = 'Expensify';
export const EXPENSIFY_CASH_REPO = 'Expensify.cash';
const EXPENSIFY_CASH_URL = 'https://github.com/Expensify/Expensify.cash';

const GITHUB_BASE_URL_REGEX = new RegExp('https?://(?:github\\.com|api\\.github\\.com)');
const PULL_REQUEST_REGEX = new RegExp(`${GITHUB_BASE_URL_REGEX.source}/.*/.*/pull/([0-9]+).*`);
const ISSUE_REGEX = new RegExp(`${GITHUB_BASE_URL_REGEX.source}/.*/.*/issues/([0-9]+).*`);
const ISSUE_OR_PULL_REQUEST_REGEX = new RegExp(`${GITHUB_BASE_URL_REGEX.source}/.*/.*/(?:pull|issues)/([0-9]+).*`);

const APPLAUSE_BOT = 'applausebot';
const STAGING_DEPLOY_CASH_LABEL = 'StagingDeployCash';

export default class GithubUtils {
    /**
     * @param {Octokit} octokit - Authenticated Octokit object https://octokit.github.io/rest.js
     */
    constructor(octokit) {
        this.octokit = octokit;
    }

    /**
     * Finds one open `StagingDeployCash` issue via GitHub octokit library.
     *
     * @returns {Promise}
     */
    getStagingDeployCash() {
        return this.octokit.issues.listForRepo({
            owner: GITHUB_OWNER,
            repo: EXPENSIFY_ISSUE_REPO,
            labels: STAGING_DEPLOY_CASH_LABEL,
            state: 'open'
        })
            .then(({data}) => {
                if (!data.length) {
                    throw new Error(`Unable to find ${STAGING_DEPLOY_CASH_LABEL} issue.`);
                }

                if (data.length > 1) {
                    throw new Error(`Found more than one ${STAGING_DEPLOY_CASH_LABEL} issue.`);
                }

                return this.getStagingDeployCashData(data[0]);
            });
    }

    /**
     * Takes in a GitHub issue object and returns the data we want.
     *
     * @private
     *
     * @param {Object} issue
     * @returns {Promise}
     */
    getStagingDeployCashData(issue) {
        try {
            const versionRegex = new RegExp('([0-9]+)\\.([0-9]+)\\.([0-9]+)(?:-([0-9]+))?', 'g');
            const tag = issue.body.match(versionRegex)[0].replace(/`/g, '');

            // eslint-disable-next-line max-len
            const compareURLRegex = new RegExp(`${EXPENSIFY_CASH_URL}/compare/${versionRegex.source}\\.\\.\\.${versionRegex.source}`, 'g');
            const comparisonURL = issue.body.match(compareURLRegex)[0];

            const checklistItemRegex = new RegExp(`- \\[[ x]] (${ISSUE_OR_PULL_REQUEST_REGEX.source})`, 'g');

            const PRListSection = issue.body.match(/pull requests:\*\*\r\n((?:.*\r\n)+)\r\n/)[1];
            const PRList = [...PRListSection.matchAll(checklistItemRegex)].map(match => match[1]);

            const deployBlockerSection = issue.body.match(/Deploy Blockers:\*\*\r\n((?:.*\r\n)+)/)[1];
            const deployBlockers = [...deployBlockerSection.matchAll(checklistItemRegex)].map(match => match[1]);

            return {
                title: issue.title, url: issue.url, labels: issue.labels, tag, comparisonURL, PRList, deployBlockers,
            };
        } catch (exception) {
            throw new Error(`Unable to find ${STAGING_DEPLOY_CASH_LABEL} issue with correct data.`);
        }
    }

    /**
     * Generate a comparison URL between two versions following the semverLevel passed
     *
     * @param {String} repoSlug - The slug of the repository: <owner>/<repository_name>
     * @param {String} tag - The tag to compare first the previous semverLevel
     * @param {String} semverLevel - The semantic versioning MAJOR, MINOR, PATCH and BUILD
     * @return {Promise} the url generated
     * @throws {Error} If the request to the Github API fails.
     */
    generateVersionComparisonURL(repoSlug, tag, semverLevel) {
        return new Promise((resolve, reject) => {
            const getComparisonURL = (previousTag, currentTag) => (
                `${EXPENSIFY_CASH_URL}/compare/${previousTag}...${currentTag}`
            );

            const [repoOwner, repoName] = repoSlug.split('/');
            const tagSemver = semverParse(tag);

            return this.octokit.repos.listTags({
                owner: repoOwner,
                repo: repoName,
            })
                .then(githubResponse => githubResponse.data.some(({name: repoTag}) => {
                    if (semverLevel === 'MAJOR'
                        && semverSatisfies(repoTag, `<${tagSemver.major}.x.x`, {includePrerelease: true})
                    ) {
                        resolve(getComparisonURL(repoTag, tagSemver));
                        return true;
                    }

                    if (semverLevel === 'MINOR'
                        && semverSatisfies(
                            repoTag,
                            `<${tagSemver.major}.${tagSemver.minor}.x`,
                            {includePrerelease: true}
                        )
                    ) {
                        resolve(getComparisonURL(repoTag, tagSemver));
                        return true;
                    }

                    if (semverLevel === 'PATCH'
                        && semverSatisfies(repoTag, `<${tagSemver}`, {includePrerelease: true})
                    ) {
                        resolve(getComparisonURL(repoTag, tagSemver));
                        return true;
                    }

                    if (semverLevel === 'BUILD'
                        && repoTag !== tagSemver.version
                        && semverSatisfies(
                            repoTag,
                            `<=${tagSemver.major}.${tagSemver.minor}.${tagSemver.patch}`,
                            {includePrerelease: true}
                        )
                    ) {
                        resolve(getComparisonURL(repoTag, tagSemver));
                        return true;
                    }
                    return false;
                }))
                .catch(githubError => reject(githubError));
        });
    }

    /**
     * Creates a new StagingDeployCash issue.
     *
     * @param {String} title
     * @param {String} tag
     * @param {Array} PRList
     * @returns {Promise}
     */
    createNewStagingDeployCash(title, tag, PRList) {
        return this.generateStagingDeployCashBody(tag, PRList)
            .then(issueBody => this.octokit.issues.create({
                owner: GITHUB_OWNER,
                repo: EXPENSIFY_ISSUE_REPO,
                labels: STAGING_DEPLOY_CASH_LABEL,
                assignee: APPLAUSE_BOT,
                title,
                body: issueBody,
            }));
    }

    /**
     * Generate the issue body for a StagingDeployCash.
     *
     * @private
     *
     * @param {String} tag
     * @param {Array} PRList - The list of PR URLs which are included in this StagingDeployCash
     * @param {Array} [verifiedPRList] - The list of PR URLs which have passed QA.
     * @param {Array} [deployBlockers] - The list of DeployBlocker URLs.
     * @param {Array} [resolvedDeployBlockers] - The list of DeployBlockers URLs which have been resolved.
     * @returns {Promise}
     */
    generateStagingDeployCashBody(
        tag,
        PRList,
        verifiedPRList = [],
        deployBlockers = [],
        resolvedDeployBlockers = []
    ) {
        return this.generateVersionComparisonURL(`${GITHUB_OWNER}/${EXPENSIFY_CASH_REPO}`, tag, 'BUILD')
            .then((comparisonURL) => {
                const sortedPRList = _.sortBy(_.unique(PRList), URL => GithubUtils.getPullRequestNumberFromURL(URL));
                // eslint-disable-next-line max-len
                const sortedDeployBlockers = _.sortBy(_.unique(deployBlockers), URL => GithubUtils.getIssueOrPullRequestNumberFromURL(URL));

                // Tag version and comparison URL
                let issueBody = `**Release Version:** ${tag}\r\n`;
                issueBody += `**Compare Changes:** ${comparisonURL}\r\n`;

                // PR list
                if (!_.isEmpty(PRList)) {
                    issueBody += '**This release contains changes from the following pull requests:**\r\n';
                    _.each(sortedPRList, (URL) => {
                        issueBody += _.contains(verifiedPRList, URL) ? '- [x]' : '- [ ]';
                        issueBody += ` ${URL}\r\n`;
                    });
                }

                // Deploy blockers
                if (!_.isEmpty(deployBlockers)) {
                    issueBody += '\r\n**Deploy Blockers:**\r\n';
                    _.each(sortedDeployBlockers, (URL) => {
                        issueBody += _.contains(resolvedDeployBlockers, URL) ? '- [x]' : '- [ ]';
                        issueBody += ` ${URL}\r\n`;
                    });
                }

                return issueBody;
            })
            // eslint-disable-next-line no-console
            .catch(err => console.warn('Error generating comparison URL, continuing...', err));
    }

    /**
     * Parse the pull request number from a URL.
     *
     * @param {String} URL
     * @returns {Number}
     * @throws {Error} If the URL is not a valid Github Pull Request.
     */
    static getPullRequestNumberFromURL(URL) {
        const matches = URL.match(PULL_REQUEST_REGEX);
        if (!_.isArray(matches) || matches.length !== 2) {
            throw new Error(`Provided URL ${URL} is not a Github Pull Request!`);
        }
        return Number.parseInt(matches[1], 10);
    }

    /**
     * Parse the issue number from a URL.
     *
     * @param {String} URL
     * @returns {Number}
     * @throws {Error} If the URL is not a valid Github Issue.
     */
    static getIssueNumberFromURL(URL) {
        const matches = URL.match(ISSUE_REGEX);
        if (!_.isArray(matches) || matches.length !== 2) {
            throw new Error(`Provided URL ${URL} is not a Github Issue!`);
        }
        return Number.parseInt(matches[1], 10);
    }

    /**
     * Parse the issue or pull request number from a URL.
     *
     * @param {String} URL
     * @returns {Number}
     * @throws {Error} If the URL is not a valid Github Issue or Pull Request.
     */
    static getIssueOrPullRequestNumberFromURL(URL) {
        const matches = URL.match(ISSUE_OR_PULL_REQUEST_REGEX);
        if (!_.isArray(matches) || matches.length !== 2) {
            throw new Error(`Provided URL ${URL} is not a valid Github Issue or Pull Request!`);
        }
        return Number.parseInt(matches[1], 10);
    }
}