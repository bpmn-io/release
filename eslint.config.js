import bpmnIoPlugin from 'eslint-plugin-bpmn-io';

const files = {
  lib: [
    '*.js',
    'bin/**/*.js',
    'lib/**/*.js'
  ],
  test: [
    'test/**/*.js'
  ]
};

export default [
  ...bpmnIoPlugin.configs.node.map(config => ({
    ...config,
    files: [
      ...files.lib,
      ...files.test
    ]
  })),
  ...bpmnIoPlugin.configs.esm.map(config => ({
    ...config,
    files: [
      ...files.lib,
      ...files.test
    ]
  }))
];
