import { createKernelId } from './ids';
import { GoalContract, KernelTask, TaskStatus } from './types';

const parseNpmVerificationCommand = (command: string): string[] => {
  if (command === 'npm test') return ['test'];
  if (command === 'npm run lint') return ['run', 'lint'];
  if (command === 'npm run build') return ['run', 'build'];
  return [];
};

export const buildInitialTaskGraph = (goal: GoalContract, now = new Date().toISOString()): KernelTask[] => {
  const tasks: KernelTask[] = [];

  for (const [index, command] of goal.verificationCommands.entries()) {
    const args = parseNpmVerificationCommand(command);
    const previousTask = tasks[index - 1];
    tasks.push({
      id: createKernelId('task'),
      goalId: goal.id,
      title: `Verification ${index + 1}: ${command}`,
      description: `Run ${command} and record command output as evidence.`,
      status: index === 0 ? 'ready' : 'pending',
      riskLevel: args.length > 0 ? 'L1' : 'L4',
      capabilityFamily: 'command.run',
      dependsOn: previousTask ? [previousTask.id] : [],
      expectedEvidence: `${command} exits with code 0.`,
      commandRequest: {
        command: 'npm',
        args,
        cwd: goal.workspaceRoot,
        expectedEvidence: `${command} exits with code 0.`,
      },
      evidenceEventIds: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  return tasks;
};

export const getNextReadyTask = (tasks: KernelTask[]): KernelTask | undefined => {
  return tasks.find((task) => task.status === 'ready' && task.dependsOn.every((dependencyId) => {
    const dependency = tasks.find((candidate) => candidate.id === dependencyId);
    return dependency?.status === 'passed';
  }));
};

export const markTaskStatus = (
  tasks: KernelTask[],
  taskId: string,
  status: TaskStatus,
  now = new Date().toISOString(),
  extra: Partial<KernelTask> = {},
): KernelTask[] => {
  const updatedTasks = tasks.map((task) => task.id === taskId ? { ...task, ...extra, status, updatedAt: now } : task);

  if (status !== 'passed') return updatedTasks;

  return updatedTasks.map((task) => {
    if (task.status !== 'pending') return task;
    const dependenciesPassed = task.dependsOn.every((dependencyId) => {
      return updatedTasks.find((candidate) => candidate.id === dependencyId)?.status === 'passed';
    });
    return dependenciesPassed ? { ...task, status: 'ready', updatedAt: now } : task;
  });
};
