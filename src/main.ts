import * as core from '@actions/core'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const token = core.getInput('token')

    const reposiory = process.env.GITHUB_REPOSITORY
    const refName = process.env.GITHUB_REF_NAME
    core.debug('Repository : ' + reposiory + ' with ref: ' + refName)
  } catch (error) {
    // Fail the workflow run if an error occurs
    if (error instanceof Error) core.setFailed(error.message)
  }
}
