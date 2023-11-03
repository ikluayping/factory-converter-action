import * as core from '@actions/core'
import Bluebird from 'bluebird'
import YAML from 'yaml'
import { Octokit } from 'octokit'
import path from 'path'
import ejs from 'ejs'
import { readFileSync } from 'fs'

/**
 * The main function for the action.
 * @returns {Promise<void>} Resolves when the action is complete.
 */
export async function run(): Promise<void> {
  try {
    const token = core.getInput('token')
    const reposiory = process.env.GITHUB_REPOSITORY
    const refName = process.env.GITHUB_REF_NAME
    const owner = process.env.GITHUB_REPOSITORY_OWNER
    core.debug(
      'Factory Repository : ' +
        reposiory +
        ' with ref: ' +
        refName +
        ' (owner: ' +
        owner +
        ')'
    )
    const ghClient = gitClient(token)
    const params = {
      repository: reposiory
        ?.replace(owner as string, '')
        .substring(1) as string,
      ref: refName as string,
      owner: owner as string
    }
    const apps = await listAppsFolder(ghClient, 'apps', params)
    const fileReult: FactoryFileResult = {
      factoryDev: [],
      factoryDeploy: []
    }
    for (const app of apps) {
      await listFactoryFile(ghClient, `apps/${app}`, params, fileReult)
    }
    await processDevPipeline(ghClient, fileReult.factoryDev, params)

    return Promise.resolve()
  } catch (error) {
    if (error instanceof Error) core.setFailed(error.message)
  }
}

const encodeB64 = (str: string): string =>
  Buffer.from(str, 'utf-8').toString('base64')
const decodeB64 = (str: string): string =>
  Buffer.from(str, 'base64').toString('utf-8')

const devOpenshiftPipeline = async (
  client: Octokit,
  params: DefaultDevPipeline
) => {
  const result = readFileSync(
    './templates/pipelines/dev/openshift.template',
    'utf8'
  )
  const template = ejs.compile(result)
  const fileContent = template({
    MODULE_NAME: params.moduleName,
    TARGET_BRANCH:
      params.devPipelineObject.template.spec.stages.pullCode.spec.gitlab.branch
  })

  // check if file exists
  const fileCheck = await client.rest.repos.getContent({
    path: `.github/workflows/${params.moduleName}.yml`,
    owner: params.owner,
    repo: params.devPipelineObject.template.spec.stages.pullCode.spec.gitlab.projectId
      ?.replace(params.owner as string, '')
      .substring(1),
    branch:
      params.devPipelineObject.template.spec.stages.pullCode.spec.gitlab.branch
  })
  if (!Array.isArray(fileCheck.data)) {
    await client.rest.repos.deleteFile({
      sha: fileCheck.data.sha,
      owner: params.owner,
      repo: params.devPipelineObject.template.spec.stages.pullCode.spec.gitlab.projectId
        ?.replace(params.owner as string, '')
        .substring(1),
      branch:
        params.devPipelineObject.template.spec.stages.pullCode.spec.gitlab
          .branch,
      message: '',
      path: `.github/workflows/${params.moduleName}.yml`
    })
  }

  await client.rest.repos
    .createOrUpdateFileContents({
      owner: params.owner,
      repo: params.devPipelineObject.template.spec.stages.pullCode.spec.gitlab.projectId
        ?.replace(params.owner as string, '')
        .substring(1),
      branch:
        params.devPipelineObject.template.spec.stages.pullCode.spec.gitlab
          .branch,
      content: encodeB64(fileContent),
      message: 'add/update file from action',
      path: `.github/workflows/${params.moduleName}.yml`
    })
    .catch(err => {
      console.log(err)
    })
}
type DefaultDevPipeline = {
  devPipelineObject: any
  moduleName: string
  owner: string
}

const processDevPipeline = async (
  client: Octokit,
  pipelinePaths: string[],
  params: RepositoryParams
) => {
  await Bluebird.map(pipelinePaths, async pipelinePath => {
    const response = await client.request(
      'GET /repos/{owner}/{repo}/contents/{path}',
      {
        owner: params.owner,
        repo: params.repository,
        ref: params.ref,
        path: pipelinePath
      }
    )
    if (!Array.isArray(response.data)) {
      if (response.data.type === 'file' && response.data.content) {
        const content = decodeB64(response.data.content)
        const devPipeline = await YAML.parse(content)
        const moduleName = path
          .parse(pipelinePath)
          .base.split('.factory-dev.yaml')[0]

        const templateType = devPipeline.template.type
        switch (templateType) {
          case 'openshift':
            await devOpenshiftPipeline(client, {
              moduleName,
              devPipelineObject: devPipeline,
              owner: params.owner
            })
            break
          default:
            core.setFailed(
              'template type is not match of any template type (' +
                templateType +
                ')'
            )
        }
      }
    }
  })
}

const gitClient = (token: string): Octokit => {
  const octokit = new Octokit({ auth: token })
  return octokit
}

type RepositoryParams = {
  repository: string
  ref: string
  owner: string
}

type FactoryFileResult = {
  factoryDev: string[]
  factoryDeploy: string[]
}

async function listFactoryFile(
  client: Octokit,
  path: string,
  params: RepositoryParams,
  fileResults: FactoryFileResult
): Promise<FactoryFileResult> {
  const response = await client.rest.repos.getContent({
    owner: params.owner,
    repo: params.repository,
    path
  })
  if (!Array.isArray(response.data)) {
    return Promise.reject(
      new UnExpectErrorException('response from github is not an array')
    )
  }

  await Bluebird.map(response.data, async item => {
    if (item.type === 'file') {
      if (item.name.endsWith('factory-dev.yaml')) {
        fileResults.factoryDev.push(item.path)
      }
      if (item.name.endsWith('factory-deploy.yaml')) {
        fileResults.factoryDeploy.push(item.path)
      }
    } else if (item.type === 'dir') {
      fileResults = await listFactoryFile(
        client,
        `${path}/${item.name}`,
        params,
        fileResults
      )
    }
  })

  if (fileResults.factoryDev.length === 0) {
    return Promise.reject(
      new NotFoundException('cannot list factory dev pipelines')
    )
  }
  return Promise.resolve(fileResults)
}

const listAppsFolder = async (
  client: Octokit,
  path: string,
  params: RepositoryParams
): Promise<string[]> => {
  try {
    const result: string[] = []

    const response = await client.rest.repos.getContent({
      owner: params.owner,
      path: path,
      repo: params.repository,
      ref: params.ref
    })

    if (Array.isArray(response.data)) {
      response.data.forEach(item => {
        if (item.type === 'dir') {
          result.push(item.name)
        }
      })
    }
    if (result.length === 0) {
      return Promise.reject(
        new NotFoundException(
          'not found any app from the repository ' + params.repository
        )
      )
    }
    return Promise.resolve(result)
  } catch (error) {
    console.log(error)
    return Promise.reject(new UnExpectErrorException(error))
  }
}

class NotFoundException implements Error {
  constructor(msg: any) {
    this.message = msg
  }
  name!: string
  message!: string
  stack?: string | undefined
  cause?: unknown
}
class UnExpectErrorException implements Error {
  constructor(msg: any) {
    this.message = msg
  }
  name!: string
  message!: string
  stack?: string | undefined
  cause?: unknown
}
